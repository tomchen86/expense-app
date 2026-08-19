import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { BUILT_IN_ENGINE_CLOSURE_MANIFEST_DIGEST } from './built-in-engine-closure-pin.ts';
import { canonicalJson } from './canonical-json.ts';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_EXECUTABLE_MODE = 0o500;
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_EXECUTABLE_BYTES = 16 * 1024 * 1024;
const MAX_CLOSURE_FILE_BYTES = 16 * 1024 * 1024;
const MAX_PROMOTION_FILE_BYTES = 16 * 1024 * 1024;
const MAX_PROMOTION_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_PROMOTION_BUNDLE_BYTES = 192 * 1024 * 1024;
const CONTROL_PLANE_GRANT_V2_MAX_TTL_MS = 5 * 60 * 1000;
const CONTROL_PLANE_SIGNATURE_NAMESPACE_V2 =
  'expense-app.control-plane-grant.v2';
const CONTROL_PLANE_REVIEW_SIGNATURE_NAMESPACE_V2 =
  'expense-app.control-plane-independent-review.v2';
const CONTROL_PLANE_SIGNATURE_NAMESPACE_V3 =
  'expense-app.control-plane-grant.v3';
const CONTROL_PLANE_REVIEW_SIGNATURE_NAMESPACE_V3 =
  'expense-app.control-plane-independent-review.v3';
const CONTROL_PLANE_HISTORY_RECORD_FILE = /^[0-9a-f]{64}\.json$/;
const RECOVERY_QUARANTINE_GRANT_ID =
  /^quarantine-(?:enter|release)-[0-9a-f]{64}$/;
const RECOVERY_QUARANTINE_HISTORY_DIRECTORY = /^[0-9a-f]{64}$/;
const RECOVERY_QUARANTINE_CLAIM_FILE = /^[0-9a-f]{64}\.json$/;
const PROCESS_TIMEOUT_MS = 10_000;
const PROCESS_MAX_BUFFER_BYTES = 1024 * 1024;
const PROTECTED_CAPABILITY_MANIFEST_PATH =
  'workflow/protected-capabilities.json';
const BUILT_IN_PROTOCOL_VERSION = 3;
const BUILT_IN_SESSION_SCHEMA = 'v4';
const BUILT_IN_POLICY_SCHEMA_VERSION = 2;
const BUILT_IN_BOOTSTRAP_RUNTIME_PATHS = [
  'packages/workflow-engine/bootstrap/built-in-engine-closure-pin.ts',
  'packages/workflow-engine/bootstrap/canonical-json.ts',
  'packages/workflow-engine/bootstrap/control-plane-trust.ts',
] as const;

const REQUIRED_BOOTSTRAP_PROTECTED_CAPABILITIES = [
  'adoption.journal',
  'apply.journal',
  'audit.append',
  'authorization.verify',
  'control-plane.update',
  'effect.monitor',
  'human.trust-roots',
  'policy.classify',
  'recovery.rollback',
  'ref-generation.ledger',
  'sandbox.enforce',
  'workflow.abort-or-supersede',
] as const;

type Sha256Digest = `sha256:${string}`;

export interface BootstrapControlPlaneSupervisorState {
  kind: 'control-plane-supervisor-state.v1';
  repositoryId: string;
  activeArtifact: {
    artifactId: Sha256Digest;
    executableDigest: Sha256Digest;
    closureDigest: Sha256Digest;
    executablePath: string;
  };
  generation: number;
  transition: {
    grantId: string;
    txId: string;
    phase: 'candidate-selected' | 'rollback-restored';
  } | null;
  updatedAt: string;
  recordDigest: Sha256Digest;
}

export interface BootstrapControlPlaneEngineArtifact {
  kind: 'engine-artifact.v1';
  sourceChangeId: string;
  sourceDigest: Sha256Digest;
  executableDigest: Sha256Digest;
  protocolVersion: number;
  canReadSessionSchemas: string[];
  writesSessionSchema: string;
  policySchemaVersion: number;
  smokeReportDigest: Sha256Digest;
  artifactId: Sha256Digest;
}

export interface BootstrapWorktreeIdentity {
  worktreeRoot: string;
  branchRef: string | null;
}

export interface BootstrapRepositoryIdentity extends BootstrapWorktreeIdentity {
  gitCommonDirectory: string;
}

export interface BootstrapInitialSupervisorHooks {
  /** Test-only deterministic interleaving seam; production callers omit it. */
  testAfterProvenanceCapture?: () => void;
  /** Test-only hard-crash seam after a durable bootstrap phase. */
  testAfterBootstrapPhase?: (
    phase: 'PREPARED' | 'ARTIFACT_MATERIALIZED' | 'SUPERVISOR_PUBLISHED',
  ) => void;
}

export interface BootstrapLocalEngineSelection {
  executablePath: string;
  executableDigest: Sha256Digest;
  resumeBinding: {
    kind: 'local-engine-resume-binding.v1';
    parentChangeId: string;
    checkpointId: Sha256Digest;
    engineDigest: Sha256Digest;
  };
}

export interface BootstrapParentInterventionFence {
  kind: 'harness-intervention';
  parentChangeId: string;
  checkpointId: Sha256Digest;
  blockedBy: string;
  parentWorkspacePath: string;
}

export interface BootstrapRecoveryQuarantineMarker {
  kind: 'recovery-quarantine-marker.v1';
  repositoryId: string;
  authorityDescriptorDigest: Sha256Digest;
  authorityGeneration: number;
  recoveryRuntimeDigest: Sha256Digest;
  externalAuditRoot: string;
  enterGrantId: string;
  enterEnvelopeDigest: Sha256Digest;
  enteredAt: string;
  markerDigest: Sha256Digest;
}

interface BootstrapPaths {
  root: string;
  supervisor: string;
  initialBootstrapJournal: string;
  bundles: string;
  artifacts: string;
  approvalCandidates: string;
  controlUpdates: string;
  supervisorHistory: string;
  checkpoints: string;
  interventions: string;
  sidecarSessions: string;
  adoptions: string;
  operations: string;
  localSessions: string;
  localArtifacts: string;
}

interface BuiltInClosureManifest {
  kind: 'built-in-engine-closure-manifest.v1';
  entrypoint: string;
  scope: 'package-json-and-all-src-typescript';
  files: Array<{
    path: string;
    mode: '100644' | '100755';
    digest: Sha256Digest;
  }>;
}

interface VerifiedBuiltInEngineClosure {
  manifest: BuiltInClosureManifest;
  manifestBytes: Buffer;
  manifestDigest: Sha256Digest;
  files: Array<{
    path: string;
    mode: '100644' | '100755';
    digest: Sha256Digest;
    bytes: Buffer;
  }>;
}

interface VerifiedProtectedCapabilityManifest {
  payload: Record<string, unknown>;
  manifestDigest: Sha256Digest;
  bootstrapRuntimeFiles: Array<{
    path: string;
    mode: '100644' | '100755';
    digest: Sha256Digest;
    bytes: Buffer;
  }>;
}

interface InitialSupervisorProvenance {
  repositoryId: string;
  branchRef: string;
  remoteBaseRef: string;
  remoteBaseOid: string;
  headOid: string;
  treeOid: string;
  packageRoot: string;
}

type InitialSupervisorBootstrapPhase =
  'PREPARED' | 'ARTIFACT_MATERIALIZED' | 'SUPERVISOR_PUBLISHED';

interface InitialSupervisorBootstrapJournalRecord {
  kind: 'initial-supervisor-bootstrap-journal.v1';
  phase: InitialSupervisorBootstrapPhase;
  provenance: InitialSupervisorProvenance;
  initializedAt: string;
  builtInClosureDigest: Sha256Digest;
  protectedManifestDigest: Sha256Digest;
  activeArtifact: BootstrapControlPlaneSupervisorState['activeArtifact'];
  supervisorRecordDigest: Sha256Digest;
  previousPhaseDigest: Sha256Digest | null;
  recordDigest: Sha256Digest;
}

interface InitialSupervisorBootstrapJournalProgress {
  completedPhases: number;
  pendingPhase: InitialSupervisorBootstrapPhase | null;
}

export interface InitialControlPlaneSupervisorAnchorEvidence {
  repositoryId: string;
  activeTrustCommit: string;
  publishedRecordDigest: Sha256Digest;
  supervisorRecordDigest: Sha256Digest;
  generation: 1;
  activeArtifact: {
    artifactId: Sha256Digest;
    executableDigest: Sha256Digest;
    closureDigest: Sha256Digest;
  };
  recordedAt: string;
}

interface BootstrapSupervisorHistoryArtifact {
  artifactId: Sha256Digest;
  executableDigest: Sha256Digest;
  closureDigest: Sha256Digest;
}

type BootstrapSupervisorHistoryAnchorAuthority =
  | {
      kind: 'initial-bootstrap-anchor.v1';
      initialBootstrapPublishedDigest: Sha256Digest;
    }
  | {
      kind: 'legacy-v2-terminal-anchor.v1';
      initialBootstrapPublishedDigest: Sha256Digest;
      grantId: string;
      txId: string;
      terminalState: 'FINALIZED' | 'ROLLED_BACK';
      updateRecordDigest: Sha256Digest;
      transactionJournalDigest: Sha256Digest;
      grantEnvelopeDigest: Sha256Digest;
      promotionBundleDigest: Sha256Digest;
    };

interface BootstrapSupervisorHistoryAnchor {
  kind: 'control-plane-supervisor-history-anchor.v1';
  sequence: 0;
  previousRecordDigest: null;
  repositoryId: string;
  generation: number;
  supervisorRecordDigest: Sha256Digest;
  activeArtifact: BootstrapSupervisorHistoryArtifact;
  activeTrustCommit: string;
  authority: BootstrapSupervisorHistoryAnchorAuthority;
  recordedAt: string;
  recordDigest: Sha256Digest;
}

interface BootstrapSupervisorHistoryTransition {
  kind: 'control-plane-supervisor-history-transition.v1';
  sequence: number;
  previousRecordDigest: Sha256Digest;
  repositoryId: string;
  phase: 'candidate-selected' | 'rollback-restored';
  fromGeneration: number;
  toGeneration: number;
  fromSupervisorRecordDigest: Sha256Digest;
  toSupervisorRecordDigest: Sha256Digest;
  activeArtifact: BootstrapSupervisorHistoryArtifact;
  activeTrustCommit: string;
  grantId: string;
  txId: string;
  grantEnvelopeDigest: Sha256Digest;
  promotionBundleDigest: Sha256Digest;
  promotionLineageDigest: Sha256Digest;
  sourceTransactionState: 'RECOVERY_VERIFIED' | 'ROLLBACK_REQUIRED';
  sourceJournalDigest: Sha256Digest;
  recordedAt: string;
  recordDigest: Sha256Digest;
}

interface BootstrapSupervisorHistoryTerminal {
  kind: 'control-plane-supervisor-history-terminal.v1';
  sequence: number;
  previousRecordDigest: Sha256Digest;
  repositoryId: string;
  generation: number;
  supervisorRecordDigest: Sha256Digest;
  activeArtifact: BootstrapSupervisorHistoryArtifact;
  activeTrustCommit: string;
  terminalState: 'FINALIZED' | 'ROLLED_BACK';
  grantId: string;
  txId: string;
  updateRecordDigest: Sha256Digest;
  transactionJournalDigest: Sha256Digest;
  grantEnvelopeDigest: Sha256Digest;
  promotionBundleDigest: Sha256Digest;
  recordedAt: string;
  recordDigest: Sha256Digest;
}

type BootstrapSupervisorHistoryRecord =
  | BootstrapSupervisorHistoryAnchor
  | BootstrapSupervisorHistoryTransition
  | BootstrapSupervisorHistoryTerminal;

interface BootstrapSupervisorHistory {
  records: BootstrapSupervisorHistoryRecord[];
  anchor: BootstrapSupervisorHistoryAnchor;
  leaf: BootstrapSupervisorHistoryTerminal;
}

interface BootstrapProtectedTreeEntry {
  path: string;
  mode: string;
  objectId: string;
  type: string;
}

type BootstrapProtectedClosureIdentity =
  | Pick<BootstrapProtectedTreeEntry, 'path' | 'mode' | 'objectId'>
  | {
      path: typeof PROTECTED_CAPABILITY_MANIFEST_PATH;
      mode: 'manifest-self';
      objectId: 'manifest-self';
    };

interface BootstrapLocalEngineBinding {
  kind: 'local-parent-session-metadata.v2';
  parentChangeId: string;
  parentWorkspacePath: string;
  parentBranch: string;
  interventionChangeId: string;
  txId: string;
  checkpointId: Sha256Digest;
  engineDigest: Sha256Digest;
  activeArtifact: {
    artifactId: Sha256Digest;
    executableDigest: Sha256Digest;
    executablePath: string;
  };
  sessionSchema: string;
  blocker: {
    kind: 'harness-intervention';
    checkpointId: Sha256Digest;
    blockedBy: string;
  } | null;
  interventionState: 'active' | 'adopted';
  generation: number;
  updatedAt: string;
  recordDigest: Sha256Digest;
}

type BootstrapAdoptionState = keyof typeof ADOPTION_HISTORIES;

interface BootstrapAdoptionJournal {
  kind: 'engine-adoption-journal.v1';
  txId: string;
  grantId: string;
  parentChangeId: string;
  interventionChangeId: string;
  checkpointId: Sha256Digest;
  fromEngineDigest: Sha256Digest;
  toEngineDigest: Sha256Digest;
  artifactId: Sha256Digest;
  sessionSchema: string;
  workflowBindingDigest?: Sha256Digest;
  workflowStatus?: 'repair-active';
  state: BootstrapAdoptionState;
  history: Array<{ state: BootstrapAdoptionState; at: string }>;
  journalDigest: Sha256Digest;
}

interface BootstrapLocalAdoptionRecord {
  schemaVersion: 1 | 2;
  journal: BootstrapAdoptionJournal;
  artifactRecordDigest: Sha256Digest | null;
}

const TERMINAL_HISTORIES = {
  FINALIZED: [
    'PREPARED',
    'OLD_CLOSURE_VERIFIED',
    'CANDIDATE_VERIFIED',
    'RECOVERY_VERIFIED',
    'SWITCHED',
    'SELF_TESTED',
    'FINALIZED',
  ],
  ROLLED_BACK: [
    'PREPARED',
    'OLD_CLOSURE_VERIFIED',
    'CANDIDATE_VERIFIED',
    'RECOVERY_VERIFIED',
    'SWITCHED',
    'ROLLBACK_REQUIRED',
    'ROLLED_BACK',
  ],
} as const;

const ADOPTION_HISTORIES = {
  PREPARED: ['PREPARED'],
  PARENT_CHECKPOINTED: ['PREPARED', 'PARENT_CHECKPOINTED'],
  ENGINE_BINDING_UPDATED: [
    'PREPARED',
    'PARENT_CHECKPOINTED',
    'ENGINE_BINDING_UPDATED',
  ],
  NEW_ENGINE_STARTED: [
    'PREPARED',
    'PARENT_CHECKPOINTED',
    'ENGINE_BINDING_UPDATED',
    'NEW_ENGINE_STARTED',
  ],
  HEALTHY: [
    'PREPARED',
    'PARENT_CHECKPOINTED',
    'ENGINE_BINDING_UPDATED',
    'NEW_ENGINE_STARTED',
    'HEALTHY',
  ],
  COMMITTED: [
    'PREPARED',
    'PARENT_CHECKPOINTED',
    'ENGINE_BINDING_UPDATED',
    'NEW_ENGINE_STARTED',
    'HEALTHY',
    'COMMITTED',
  ],
  ROLLBACK_REQUIRED: [
    'PREPARED',
    'PARENT_CHECKPOINTED',
    'ENGINE_BINDING_UPDATED',
    'NEW_ENGINE_STARTED',
    'ROLLBACK_REQUIRED',
  ],
  ENGINE_BINDING_ROLLED_BACK: [
    'PREPARED',
    'PARENT_CHECKPOINTED',
    'ENGINE_BINDING_UPDATED',
    'NEW_ENGINE_STARTED',
    'ROLLBACK_REQUIRED',
    'ENGINE_BINDING_ROLLED_BACK',
  ],
} as const;

/** Derive the updater state location without consulting the swappable engine. */
export function bootstrapInterventionStateRoot(
  gitCommonDirectory: string,
): string {
  if (
    typeof gitCommonDirectory !== 'string' ||
    !path.isAbsolute(gitCommonDirectory) ||
    path.resolve(gitCommonDirectory) !== gitCommonDirectory ||
    fs.realpathSync(gitCommonDirectory) !== gitCommonDirectory
  ) {
    throw trustError(
      'WORKFLOW_LAUNCHER_REPOSITORY_UNSAFE',
      'Git common directory is not an exact real path.',
      12,
    );
  }
  return path.join(
    gitCommonDirectory,
    'workflow-engine',
    'intervention-control',
  );
}

/**
 * Recovery Authority state is deliberately disjoint from the swappable
 * intervention/control-plane store. The Git common directory is the only
 * caller input; neither an engine nor an argv value can redirect the fence.
 */
export function bootstrapRecoveryAuthorityStateRoot(
  gitCommonDirectory: string,
): string {
  return path.join(
    path.dirname(bootstrapInterventionStateRoot(gitCommonDirectory)),
    'recovery-authority-state',
  );
}

/**
 * Read the quarantine marker without importing any swappable src/ module.
 * A genuinely absent canonical root means "not quarantined". Every present
 * byte is inventoried and verified as private canonical Recovery Authority
 * state before marker absence can be trusted.
 *
 * This is only the production launch fence. Recovery Authority provisioning
 * and quarantine enter/release remain substrate APIs until separately sealed
 * harness commands are implemented; this reader does not manufacture either
 * transition.
 */
export function resolveRecoveryQuarantineMarker(
  gitCommonDirectory: string,
): BootstrapRecoveryQuarantineMarker | null {
  const inventory = recoveryAuthorityRootInventory(gitCommonDirectory);
  if (inventory === null) return null;
  const { storageRoot, rootEntries } = inventory;
  const quarantineRoot = path.join(storageRoot, 'recovery-quarantine');
  if (!rootEntries.some((entry) => entry.name === 'recovery-quarantine')) {
    return null;
  }
  return readRecoveryQuarantineInventory(quarantineRoot);
}

/**
 * Presence of the append-only restored-root subtree is itself a bootstrap
 * fence. Bootstrap deliberately does not interpret the swappable substrate's
 * deeper records here: any present private directory keeps ordinary workflow
 * execution fail closed until a separately pinned operational channel exists.
 */
export function resolveRecoveryOperationalTrustRootFence(
  gitCommonDirectory: string,
): boolean {
  const inventory = recoveryAuthorityRootInventory(gitCommonDirectory);
  return (
    inventory?.rootEntries.some(
      (entry) => entry.name === 'recovery-operational-trust-root',
    ) ?? false
  );
}

function recoveryAuthorityRootInventory(
  gitCommonDirectory: string,
): { storageRoot: string; rootEntries: fs.Dirent[] } | null {
  const storageRoot = bootstrapRecoveryAuthorityStateRoot(gitCommonDirectory);
  const stateParent = path.dirname(storageRoot);
  const parent = fs.lstatSync(stateParent, { throwIfNoEntry: false });
  if (parent === undefined) return null;
  assertRecoveryDirectory(stateParent, false);
  const root = fs.lstatSync(storageRoot, { throwIfNoEntry: false });
  if (root === undefined) return null;
  assertRecoveryDirectory(storageRoot, true);

  const rootEntries = recoveryDirectoryEntries(storageRoot);
  for (const entry of rootEntries) {
    if (
      entry.name !== 'recovery-authority' &&
      entry.name !== 'recovery-quarantine' &&
      entry.name !== 'recovery-operational-trust-root'
    ) {
      throw recoveryQuarantineStateCorrupt();
    }
    assertRecoveryDirectory(path.join(storageRoot, entry.name), true);
  }
  if (rootEntries.some((entry) => entry.name === 'recovery-authority')) {
    assertRecoveryAuthorityInventory(
      path.join(storageRoot, 'recovery-authority'),
    );
  }
  return { storageRoot, rootEntries };
}

/**
 * Resolve the exact active engine using only bootstrap-owned verification.
 * Null is allowed only for a repository that has never materialized a
 * supervisor artifact or promotion bundle.
 */
export function resolveControlPlaneEngineSelection(
  storageRoot: string,
  expectedRepositoryId?: string,
): BootstrapControlPlaneSupervisorState | null {
  const paths = bootstrapPaths(storageRoot);
  const supervisor = fs.lstatSync(paths.supervisor, { throwIfNoEntry: false });
  if (supervisor === undefined) {
    assertNoOrphanedGlobalControlPlaneState(paths);
    return null;
  }

  assertPrivateDirectory(paths.root, 'CONTROL_PLANE_STATE_UNSAFE');
  const state = readSupervisor(paths);
  if (
    expectedRepositoryId !== undefined &&
    state.repositoryId !== expectedRepositoryId
  ) {
    throw trustError(
      'CONTROL_PLANE_SUPERVISOR_REPOSITORY_MISMATCH',
      'Control-plane supervisor belongs to another trusted repository identity.',
      11,
    );
  }
  assertTerminalSelection(paths, state);
  runRestartProbe(paths, state);
  return deepFreeze(structuredClone(state));
}

/** Resolve the repository identity from clean Git inputs, never mutable src. */
export function verifyBootstrapRepositoryIdentity(
  identity: BootstrapRepositoryIdentity,
): string {
  assertBootstrapRepositoryPaths(identity);
  const captured = readBootstrapHeadAndTree(identity.worktreeRoot);
  const repositoryId = verifyBootstrapRepositoryIdentityAt(
    identity,
    captured.headOid,
  );
  const observed = readBootstrapHeadAndTree(identity.worktreeRoot);
  const observedRepositoryId = verifyBootstrapRepositoryIdentityAt(
    identity,
    captured.headOid,
  );
  if (
    observed.headOid !== captured.headOid ||
    observed.treeOid !== captured.treeOid ||
    observedRepositoryId !== repositoryId
  ) {
    throw bootstrapRepositoryIdentityInvalid();
  }
  return repositoryId;
}

function verifyBootstrapRepositoryIdentityAt(
  identity: BootstrapRepositoryIdentity,
  revision: string,
): string {
  const observedCommonDirectory = exactBootstrapGitOutput(
    identity.worktreeRoot,
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
  );
  const observedWorktreeRoot = exactBootstrapGitOutput(identity.worktreeRoot, [
    'rev-parse',
    '--path-format=absolute',
    '--show-toplevel',
  ]);
  let exactCommonDirectory: string;
  let exactWorktreeRoot: string;
  try {
    if (
      observedCommonDirectory.includes('\n') ||
      observedWorktreeRoot.includes('\n')
    ) {
      throw bootstrapRepositoryIdentityInvalid();
    }
    exactCommonDirectory = fs.realpathSync(observedCommonDirectory);
    exactWorktreeRoot = fs.realpathSync(observedWorktreeRoot);
  } catch {
    throw bootstrapRepositoryIdentityInvalid();
  }
  if (
    exactCommonDirectory !== identity.gitCommonDirectory ||
    exactWorktreeRoot !== identity.worktreeRoot
  ) {
    throw bootstrapRepositoryIdentityInvalid();
  }
  const policyBytes = exactBootstrapGitOutput(identity.worktreeRoot, [
    'show',
    `${revision}:workflow/maintainer-policy.json`,
  ]);
  if (Buffer.byteLength(policyBytes) > MAX_STATE_BYTES) {
    throw bootstrapRepositoryIdentityInvalid();
  }
  let policy: unknown;
  try {
    policy = JSON.parse(policyBytes);
  } catch {
    throw bootstrapRepositoryIdentityInvalid();
  }
  if (
    !isRecord(policy) ||
    !isRecord(policy.repository) ||
    !isNonEmptyTrimmed(policy.repository.id) ||
    policy.repository.id.length > 512 ||
    !/^github:[A-Za-z0-9_.:-]+$/.test(policy.repository.id) ||
    !isNonEmptyTrimmed(policy.repository.origin) ||
    policy.repository.origin.length > 2_048 ||
    !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(
      policy.repository.origin,
    )
  ) {
    throw bootstrapRepositoryIdentityInvalid();
  }
  const origin = exactBootstrapGitOutput(identity.worktreeRoot, [
    'config',
    '--local',
    '--get',
    'remote.origin.url',
  ]);
  if (origin.includes('\n') || origin !== policy.repository.origin) {
    throw bootstrapRepositoryIdentityInvalid();
  }
  return policy.repository.id;
}

function captureInitialSupervisorProvenance(
  identity: BootstrapRepositoryIdentity,
  packageRoot: string,
): InitialSupervisorProvenance {
  assertBootstrapRepositoryPaths(identity);
  const expectedPackageRoot = path.join(
    identity.worktreeRoot,
    'packages',
    'workflow-engine',
  );
  if (packageRoot !== expectedPackageRoot) {
    throw bootstrapPackageRootInvalid();
  }
  assertTrackedBootstrapPackageRoot(packageRoot);

  let branchRef: string;
  try {
    branchRef = exactBootstrapGitOutput(identity.worktreeRoot, [
      'symbolic-ref',
      '-q',
      'HEAD',
    ]);
  } catch {
    throw bootstrapBaseMismatch();
  }
  if (
    identity.branchRef !== branchRef ||
    !/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(branchRef)
  ) {
    throw bootstrapBaseMismatch();
  }

  const { headOid, treeOid } = readBootstrapHeadAndTree(identity.worktreeRoot);
  const branchHead = exactBootstrapGitOutput(identity.worktreeRoot, [
    'rev-parse',
    '--verify',
    `${branchRef}^{commit}`,
  ]);
  if (branchHead !== headOid) throw bootstrapBaseMismatch();

  const configRaw = exactBootstrapGitOutput(identity.worktreeRoot, [
    'show',
    `${headOid}:workflow/config.json`,
  ]);
  let config: unknown;
  try {
    config = JSON.parse(configRaw);
  } catch {
    throw bootstrapBaseMismatch();
  }
  if (
    !isRecord(config) ||
    !Array.isArray(config.protectedBranches) ||
    config.protectedBranches.length === 0 ||
    !config.protectedBranches.every(
      (entry) =>
        typeof entry === 'string' &&
        /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(entry) &&
        !entry.includes('..'),
    ) ||
    `refs/heads/${String(config.protectedBranches[0])}` !== branchRef
  ) {
    throw bootstrapBaseMismatch();
  }
  const remoteBaseRef = `refs/remotes/origin/${String(config.protectedBranches[0])}`;
  const remoteBaseOid = readBootstrapRemoteBaseOid(
    identity.worktreeRoot,
    remoteBaseRef,
  );
  if (remoteBaseOid !== headOid) throw bootstrapRemoteBaseMismatch();

  const repositoryId = verifyBootstrapRepositoryIdentityAt(identity, headOid);
  assertBootstrapRepositoryClean(identity.worktreeRoot);
  const tree = readBootstrapHeadTree(identity.worktreeRoot, headOid);
  const requiredTrackedPaths = [
    'packages/workflow-engine/package.json',
    'packages/workflow-engine/bootstrap/built-in-engine-closure.json',
    'packages/workflow-engine/bootstrap/built-in-engine-closure-pin.ts',
    'packages/workflow-engine/bootstrap/canonical-json.ts',
    'packages/workflow-engine/bootstrap/control-plane-trust.ts',
    'packages/workflow-engine/bootstrap/workflow-launcher.ts',
  ];
  for (const requiredPath of requiredTrackedPaths) {
    const entry = tree.find((candidate) => candidate.path === requiredPath);
    if (
      entry?.type !== 'blob' ||
      (entry.mode !== '100644' && entry.mode !== '100755')
    ) {
      throw bootstrapPackageRootInvalid();
    }
  }
  return {
    repositoryId,
    branchRef,
    remoteBaseRef,
    remoteBaseOid,
    headOid,
    treeOid,
    packageRoot,
  };
}

function assertInitialSupervisorProvenanceUnchanged(
  identity: BootstrapRepositoryIdentity,
  provenance: InitialSupervisorProvenance,
): void {
  try {
    assertBootstrapRepositoryPaths(identity);
    assertTrackedBootstrapPackageRoot(provenance.packageRoot);
    const branchRef = exactBootstrapGitOutput(identity.worktreeRoot, [
      'symbolic-ref',
      '-q',
      'HEAD',
    ]);
    const observed = readBootstrapHeadAndTree(identity.worktreeRoot);
    const remoteBaseOid = readBootstrapRemoteBaseOid(
      identity.worktreeRoot,
      provenance.remoteBaseRef,
    );
    const repositoryId = verifyBootstrapRepositoryIdentityAt(
      identity,
      provenance.headOid,
    );
    assertBootstrapRepositoryClean(identity.worktreeRoot);
    if (
      branchRef !== provenance.branchRef ||
      identity.branchRef !== provenance.branchRef ||
      observed.headOid !== provenance.headOid ||
      observed.treeOid !== provenance.treeOid ||
      remoteBaseOid !== provenance.remoteBaseOid ||
      repositoryId !== provenance.repositoryId
    ) {
      throw bootstrapProvenanceChanged();
    }
  } catch (error) {
    if (
      isRecord(error) &&
      error.code === 'CONTROL_PLANE_BOOTSTRAP_PROVENANCE_CHANGED'
    ) {
      throw error;
    }
    throw bootstrapProvenanceChanged();
  }
}

function readBootstrapRemoteBaseOid(
  worktreeRoot: string,
  remoteBaseRef: string,
): string {
  if (
    !/^refs\/remotes\/origin\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(remoteBaseRef)
  ) {
    throw bootstrapRemoteBaseMismatch();
  }
  let oid: string;
  try {
    oid = exactBootstrapGitOutput(worktreeRoot, [
      'rev-parse',
      '--verify',
      `${remoteBaseRef}^{commit}`,
    ]);
  } catch {
    throw bootstrapRemoteBaseMismatch();
  }
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) {
    throw bootstrapRemoteBaseMismatch();
  }
  return oid;
}

function readBootstrapHeadAndTree(worktreeRoot: string): {
  headOid: string;
  treeOid: string;
} {
  const headOid = exactBootstrapGitOutput(worktreeRoot, [
    'rev-parse',
    '--verify',
    'HEAD^{commit}',
  ]);
  const treeOid = exactBootstrapGitOutput(worktreeRoot, [
    'rev-parse',
    '--verify',
    `${headOid}^{tree}`,
  ]);
  if (
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(headOid) ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(treeOid)
  ) {
    throw bootstrapRepositoryIdentityInvalid();
  }
  return { headOid, treeOid };
}

function assertTrackedBootstrapPackageRoot(packageRoot: string): void {
  const stats = fs.lstatSync(packageRoot, { throwIfNoEntry: false });
  if (
    !stats?.isDirectory() ||
    stats.isSymbolicLink() ||
    path.resolve(packageRoot) !== packageRoot ||
    fs.realpathSync(packageRoot) !== packageRoot
  ) {
    throw bootstrapPackageRootInvalid();
  }
}

/**
 * One-time sealed bootstrap for the repository-default E1 supervisor. The
 * mutable engine cannot supply artifact bytes, closure identity, repository
 * identity, or durable state. Re-entry is exact and byte-idempotent.
 */
export function initializeBuiltInControlPlaneSupervisor(
  storageRoot: string,
  packageRoot: string,
  identity: BootstrapRepositoryIdentity,
  now: Date = new Date(),
  hooks: BootstrapInitialSupervisorHooks = {},
): BootstrapControlPlaneSupervisorState {
  if (
    bootstrapInterventionStateRoot(identity.gitCommonDirectory) !== storageRoot
  ) {
    throw bootstrapRepositoryIdentityInvalid();
  }
  const timestamp = new Date(now);
  if (!Number.isFinite(timestamp.getTime())) {
    throw trustError(
      'CONTROL_PLANE_SUPERVISOR_INVALID',
      'Initial supervisor timestamp is invalid.',
      10,
    );
  }
  const provenance = captureInitialSupervisorProvenance(identity, packageRoot);
  hooks.testAfterProvenanceCapture?.();
  assertInitialSupervisorProvenanceUnchanged(identity, provenance);
  const closure = verifiedBuiltInEngineClosure(packageRoot);
  assertBuiltInClosureTrackedAtProvenance(
    identity.worktreeRoot,
    provenance,
    closure,
  );
  const protectedManifest = verifiedProtectedCapabilityManifest(
    identity.worktreeRoot,
    provenance.headOid,
  );
  assertInitialSupervisorProvenanceUnchanged(identity, provenance);
  const paths = bootstrapPaths(storageRoot);
  const executableBytes = Buffer.from(
    builtInSupervisorExecutableSource(
      closure.manifestDigest,
      protectedManifest.manifestDigest,
      closure.manifest.entrypoint,
      protectedManifest.bootstrapRuntimeFiles,
    ),
  );
  const executableDigest = rawDigest(executableBytes);
  const engineArtifact = createBuiltInControlPlaneEngineArtifact(
    closure.manifestDigest,
    protectedManifest.manifestDigest,
    executableDigest,
  );
  const artifactId = engineArtifact.artifactId;
  const executablePath = path.join(
    paths.artifacts,
    artifactId.slice('sha256:'.length),
    'engine',
  );
  const expectedArtifact = {
    artifactId,
    executableDigest,
    closureDigest: protectedManifest.manifestDigest,
    executablePath,
  };
  assertInitialSupervisorProvenanceUnchanged(identity, provenance);
  ensureInitialStateRoot(paths.root);
  initialGlobalNamespaceState(paths, artifactId);
  assertInitialSupervisorProvenanceUnchanged(identity, provenance);
  ensureInitialBootstrapJournalDirectory(paths);
  const journalProgress = assertInitialBootstrapJournalInventory(paths);
  const initializedAt = resolveInitialBootstrapTimestamp(
    paths,
    provenance,
    closure.manifestDigest,
    protectedManifest.manifestDigest,
    expectedArtifact,
    timestamp.toISOString(),
  );
  const payload = {
    kind: 'control-plane-supervisor-state.v1' as const,
    repositoryId: provenance.repositoryId,
    activeArtifact: expectedArtifact,
    generation: 1,
    transition: null,
    updatedAt: initializedAt,
  };
  const state: BootstrapControlPlaneSupervisorState = {
    ...payload,
    recordDigest: canonicalDigest(payload),
  };
  const journal = createInitialSupervisorBootstrapJournal(
    provenance,
    initializedAt,
    closure.manifestDigest,
    protectedManifest.manifestDigest,
    expectedArtifact,
    state.recordDigest,
  );
  assertExistingInitialBootstrapJournalRecords(paths, journal);

  assertInitialSupervisorProvenanceUnchanged(identity, provenance);
  publishInitialBootstrapJournalPhase(paths, journal.PREPARED);
  hooks.testAfterBootstrapPhase?.('PREPARED');

  assertInitialSupervisorProvenanceUnchanged(identity, provenance);
  if (
    journalProgress.completedPhases >= 2 ||
    journalProgress.pendingPhase === 'ARTIFACT_MATERIALIZED' ||
    journalProgress.pendingPhase === 'SUPERVISOR_PUBLISHED'
  ) {
    assertMaterializedBuiltInClosure(
      paths,
      closure,
      protectedManifest.bootstrapRuntimeFiles,
      engineArtifact,
      executableBytes,
    );
  } else {
    materializeBuiltInClosure(
      paths,
      closure,
      protectedManifest,
      engineArtifact,
      executableBytes,
    );
  }
  assertInitialSupervisorProvenanceUnchanged(identity, provenance);
  publishInitialBootstrapJournalPhase(paths, journal.ARTIFACT_MATERIALIZED);
  hooks.testAfterBootstrapPhase?.('ARTIFACT_MATERIALIZED');

  assertInitialSupervisorProvenanceUnchanged(identity, provenance);
  if (
    journalProgress.completedPhases >= 3 ||
    journalProgress.pendingPhase === 'SUPERVISOR_PUBLISHED'
  ) {
    const alreadyPublished = readSupervisor(paths);
    if (canonicalJson(alreadyPublished) !== canonicalJson(state)) {
      throw initialBootstrapJournalCorrupt();
    }
  }
  publishExactPrivateFile(
    paths.supervisor,
    `${canonicalJson(state)}\n`,
    PRIVATE_FILE_MODE,
    supervisorAlreadyInitialized,
  );
  const persisted = readSupervisor(paths);
  if (canonicalJson(persisted) !== canonicalJson(state)) {
    throw supervisorAlreadyInitialized();
  }
  assertInitialSupervisorProvenanceUnchanged(identity, provenance);
  publishInitialBootstrapJournalPhase(paths, journal.SUPERVISOR_PUBLISHED);
  hooks.testAfterBootstrapPhase?.('SUPERVISOR_PUBLISHED');
  assertInitialBootstrapJournalComplete(paths, journal);
  assertBuiltInControlPlaneEngineArtifact(
    paths,
    persisted,
    engineArtifact,
    closure,
    protectedManifest,
  );
  runRestartProbe(paths, persisted);
  return deepFreeze(structuredClone(persisted));
}

/** Read the exact full EngineArtifact needed by a first recovery bundle. */
export function readBuiltInControlPlaneEngineArtifact(
  storageRoot: string,
): BootstrapControlPlaneEngineArtifact {
  const paths = bootstrapPaths(storageRoot);
  assertPrivateDirectory(paths.root, 'CONTROL_PLANE_STATE_UNSAFE');
  const supervisor = readSupervisor(paths);
  const artifact = readBuiltInEngineArtifactRecord(
    path.join(
      paths.artifacts,
      supervisor.activeArtifact.artifactId.slice('sha256:'.length),
      'engine-artifact.json',
    ),
  );
  if (
    artifact.artifactId !== supervisor.activeArtifact.artifactId ||
    artifact.executableDigest !== supervisor.activeArtifact.executableDigest
  ) {
    throw bootstrapArtifactMismatch();
  }
  return deepFreeze(structuredClone(artifact));
}

/**
 * Return the immutable generation-one anchor only after independently
 * replaying the complete three-phase bootstrap journal. Successor producers
 * use this digest as the root of the append-only supervisor history; callers
 * cannot nominate or synthesize an anchor.
 */
export function readInitialControlPlaneSupervisorAnchorEvidence(
  storageRoot: string,
  expectedRepositoryId: string,
): InitialControlPlaneSupervisorAnchorEvidence {
  const paths = bootstrapPaths(storageRoot);
  const prepared = assertPromotionHasValidInitialBootstrapAnchor(
    paths,
    expectedRepositoryId,
  );
  const published = readInitialBootstrapJournalRecord(
    path.join(
      paths.initialBootstrapJournal,
      INITIAL_BOOTSTRAP_PHASE_FILES.SUPERVISOR_PUBLISHED,
    ),
  );
  return deepFreeze({
    repositoryId: prepared.provenance.repositoryId,
    activeTrustCommit: prepared.provenance.headOid,
    publishedRecordDigest: published.recordDigest,
    supervisorRecordDigest: prepared.supervisorRecordDigest,
    generation: 1 as const,
    activeArtifact: {
      artifactId: prepared.activeArtifact.artifactId,
      executableDigest: prepared.activeArtifact.executableDigest,
      closureDigest: prepared.activeArtifact.closureDigest,
    },
    recordedAt: prepared.initializedAt,
  });
}

/**
 * Resolve the bootstrap-owned pause fence created with the parent's WIP
 * checkpoint. The mutable engine is deliberately not involved: a broken E1
 * must not be able to omit or weaken the fence that pauses its parent.
 */
export function resolveParentInterventionFence(
  storageRoot: string,
  identity: BootstrapWorktreeIdentity,
): BootstrapParentInterventionFence | null {
  const parentChangeId = parentChangeIdFromBranch(identity.branchRef);
  if (parentChangeId === null) return null;
  assertExactWorktreeRoot(identity.worktreeRoot);
  const paths = bootstrapPaths(storageRoot);
  const interventionDirectory = fs.lstatSync(paths.interventions, {
    throwIfNoEntry: false,
  });
  if (interventionDirectory === undefined) return null;
  assertPrivateDirectory(
    paths.root,
    'WORKFLOW_PARENT_INTERVENTION_STATE_UNSAFE',
  );
  assertPrivateDirectory(
    paths.interventions,
    'WORKFLOW_PARENT_INTERVENTION_STATE_UNSAFE',
  );
  const recordPath = path.join(
    paths.interventions,
    `${identityFileName('intervention', parentChangeId)}.json`,
  );
  if (fs.lstatSync(recordPath, { throwIfNoEntry: false }) === undefined) {
    return null;
  }
  const value = readCanonicalPrivateRecord(
    recordPath,
    interventionFenceCorrupt,
  );
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'checkpoint',
      'childWorkspace',
      'createdAt',
      'kind',
      'parent',
      'recordDigest',
      'relationship',
    ]) ||
    value.kind !== 'persisted-harness-intervention.v1' ||
    !verifyRecordDigest(value) ||
    !isCanonicalIso(value.createdAt) ||
    !isRecord(value.parent) ||
    !isRecord(value.relationship) ||
    !isRecord(value.checkpoint) ||
    !isRecord(value.childWorkspace)
  ) {
    throw interventionFenceCorrupt();
  }
  const parent = value.parent;
  const relationship = value.relationship;
  const checkpoint = value.checkpoint;
  const childWorkspace = value.childWorkspace;
  if (
    !hasExactKeys(parent, [
      'blocker',
      'changeId',
      'engineBinding',
      'sessionSchema',
      'status',
    ]) ||
    parent.changeId !== parentChangeId ||
    parent.status !== 'active' ||
    !isDigest(parent.engineBinding) ||
    !isNonEmptyTrimmed(parent.sessionSchema) ||
    !isRecord(parent.blocker) ||
    !hasExactKeys(parent.blocker, ['blockedBy', 'checkpointId', 'kind']) ||
    parent.blocker.kind !== 'harness-intervention' ||
    !isDigest(parent.blocker.checkpointId) ||
    !isNonEmptyTrimmed(parent.blocker.blockedBy) ||
    !hasExactKeys(relationship, [
      'checkpointId',
      'interventionChangeId',
      'kind',
      'parentChangeId',
      'state',
      'unblocks',
    ]) ||
    relationship.kind !== 'harness-intervention.v1' ||
    relationship.parentChangeId !== parentChangeId ||
    relationship.unblocks !== parentChangeId ||
    relationship.state !== 'active' ||
    relationship.interventionChangeId !== parent.blocker.blockedBy ||
    relationship.checkpointId !== parent.blocker.checkpointId ||
    !validInterventionCheckpoint(checkpoint, parentChangeId) ||
    checkpoint.checkpointId !== parent.blocker.checkpointId ||
    checkpoint.engineDigest !== parent.engineBinding ||
    !validInterventionChildWorkspace(
      childWorkspace,
      identity.worktreeRoot,
      parentChangeId,
      String(relationship.interventionChangeId),
      String(checkpoint.checkpointId),
      String(checkpoint.baseOid),
    )
  ) {
    throw interventionFenceCorrupt();
  }
  assertStoredInterventionCheckpoint(paths, checkpoint);
  return deepFreeze({
    kind: 'harness-intervention',
    parentChangeId,
    checkpointId: checkpoint.checkpointId as Sha256Digest,
    blockedBy: relationship.interventionChangeId as string,
    parentWorkspacePath: identity.worktreeRoot,
  });
}

/** A committed, exact local overlay is the only automatic fence release. */
export function assertParentInterventionFenceCleared(
  fence: BootstrapParentInterventionFence | null,
  selection: BootstrapLocalEngineSelection | null,
): void {
  if (fence === null) return;
  if (
    selection !== null &&
    selection.resumeBinding.parentChangeId === fence.parentChangeId &&
    selection.resumeBinding.checkpointId === fence.checkpointId
  ) {
    return;
  }
  throw trustError(
    'WORKFLOW_PARENT_INTERVENTION_BLOCKED',
    `Parent change ${fence.parentChangeId} is paused by harness intervention ${fence.blockedBy}; use the sealed harness-bootstrap recovery lane.`,
    14,
  );
}

/**
 * Resolve a committed parent-session overlay. Detached, unrelated, or
 * non-canonical worktree branches deliberately do not observe local state.
 */
export function resolveLocalEngineSelection(
  storageRoot: string,
  identity: BootstrapWorktreeIdentity,
): BootstrapLocalEngineSelection | null {
  const parentChangeId = parentChangeIdFromBranch(identity.branchRef);
  if (parentChangeId === null) return null;
  assertExactWorktreeRoot(identity.worktreeRoot);
  const paths = bootstrapPaths(storageRoot);
  const bindingPath = path.join(
    paths.localSessions,
    `${identityFileName('parent-session', parentChangeId)}.json`,
  );
  if (fs.lstatSync(bindingPath, { throwIfNoEntry: false }) === undefined) {
    return null;
  }
  assertPrivateDirectory(paths.root, 'WORKFLOW_LOCAL_ADOPTION_STATE_UNSAFE');
  assertPrivateDirectory(
    paths.localSessions,
    'WORKFLOW_LOCAL_ADOPTION_STATE_UNSAFE',
  );
  const binding = readLocalBinding(bindingPath);
  if (
    binding.parentChangeId !== parentChangeId ||
    binding.parentBranch !== identity.branchRef ||
    binding.parentWorkspacePath !== identity.worktreeRoot
  ) {
    throw localBindingMismatch();
  }
  const adoptionPath = path.join(
    paths.adoptions,
    `${identityFileName('adoption', binding.txId)}.json`,
  );
  assertPrivateDirectory(
    paths.adoptions,
    'WORKFLOW_LOCAL_ADOPTION_STATE_UNSAFE',
  );
  const adoption = readLocalAdoptionJournal(adoptionPath, binding.txId);
  const journal = adoption.journal;
  assertLocalBindingJournalIdentity(paths, binding, journal);

  if (adoption.schemaVersion === 2) {
    assertLocalAdoptionWorkflowBinding(
      paths,
      journal,
      adoption.artifactRecordDigest,
    );
  }

  if (journal.state === 'ENGINE_BINDING_ROLLED_BACK') {
    assertTerminalRolledBackBinding(binding, journal);
    return null;
  }
  if (journal.state !== 'COMMITTED') {
    assertPermittedIncompleteBinding(binding, journal);
    throw trustError(
      'WORKFLOW_LOCAL_ADOPTION_INCOMPLETE',
      'Local engine adoption is not terminal; use harness-bootstrap to inspect or recover it.',
      14,
    );
  }
  if (adoption.schemaVersion === 1) {
    throw trustError(
      'WORKFLOW_LOCAL_ADOPTION_WORKFLOW_BINDING_REQUIRED',
      'Historical V1 local adoption metadata is readable but cannot authorize an engine launch.',
      13,
    );
  }
  assertTerminalCommittedBinding(binding, journal);
  verifyLocalEngineArtifact(paths, binding.activeArtifact);
  return deepFreeze({
    executablePath: binding.activeArtifact.executablePath,
    executableDigest: binding.activeArtifact.executableDigest,
    resumeBinding: {
      kind: 'local-engine-resume-binding.v1',
      parentChangeId: binding.parentChangeId,
      checkpointId: binding.checkpointId,
      engineDigest: binding.engineDigest,
    },
  });
}

/** Verify and return the pinned pristine E1 entrypoint. */
export function verifyBuiltInEngineClosure(packageRoot: string): string {
  const closure = verifiedBuiltInEngineClosure(packageRoot);
  return path.join(packageRoot, ...closure.manifest.entrypoint.split('/'));
}

function verifiedBuiltInEngineClosure(
  packageRoot: string,
): VerifiedBuiltInEngineClosure {
  assertExactPackageRoot(packageRoot);
  const manifestPath = path.join(
    packageRoot,
    'bootstrap',
    'built-in-engine-closure.json',
  );
  const manifestBytes = readClosureFile(manifestPath, 0o644);
  if (rawDigest(manifestBytes) !== BUILT_IN_ENGINE_CLOSURE_MANIFEST_DIGEST) {
    throw builtInClosureMismatch();
  }

  let value: unknown;
  try {
    value = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw builtInClosureMismatch();
  }
  if (
    `${JSON.stringify(value, null, 2)}\n` !== manifestBytes.toString('utf8')
  ) {
    throw builtInClosureMismatch();
  }
  const manifest = verifyClosureManifest(value);
  const observedTypescript = listPackageTypescriptFiles(
    packageRoot,
    path.join(packageRoot, 'src'),
  );
  const expectedTypescript = manifest.files
    .map((entry) => entry.path)
    .filter((entry) => entry.startsWith('src/'));
  if (canonicalJson(observedTypescript) !== canonicalJson(expectedTypescript)) {
    throw builtInClosureMismatch();
  }

  const files = manifest.files.map((entry) => {
    const absolute = path.join(packageRoot, ...entry.path.split('/'));
    const expectedMode = entry.mode === '100755' ? 0o755 : 0o644;
    const bytes = readClosureFile(absolute, expectedMode);
    if (rawDigest(bytes) !== entry.digest) throw builtInClosureMismatch();
    return { ...entry, bytes };
  });
  return {
    manifest,
    manifestBytes,
    manifestDigest: BUILT_IN_ENGINE_CLOSURE_MANIFEST_DIGEST,
    files,
  };
}

function assertBuiltInClosureTrackedAtProvenance(
  worktreeRoot: string,
  provenance: InitialSupervisorProvenance,
  closure: VerifiedBuiltInEngineClosure,
): void {
  const tree = readBootstrapHeadTree(worktreeRoot, provenance.headOid);
  const expected = [
    {
      path: 'bootstrap/built-in-engine-closure.json',
      mode: '100644' as const,
      bytes: closure.manifestBytes,
    },
    ...closure.files.map(({ path: filePath, mode, bytes }) => ({
      path: filePath,
      mode,
      bytes,
    })),
  ];
  for (const entry of expected) {
    const tracked = tree.find(
      (candidate) =>
        candidate.path === `packages/workflow-engine/${entry.path}`,
    );
    const repositoryPath = `packages/workflow-engine/${entry.path}`;
    if (
      tracked?.type !== 'blob' ||
      tracked.mode !== entry.mode ||
      !readBootstrapGitBlob(
        worktreeRoot,
        provenance.headOid,
        repositoryPath,
      ).equals(entry.bytes)
    ) {
      throw bootstrapPackageRootInvalid();
    }
  }
}

function bootstrapPaths(storageRoot: string): BootstrapPaths {
  if (
    typeof storageRoot !== 'string' ||
    !path.isAbsolute(storageRoot) ||
    path.resolve(storageRoot) !== storageRoot ||
    storageRoot === path.parse(storageRoot).root
  ) {
    throw trustError(
      'CONTROL_PLANE_STATE_ROOT_INVALID',
      'Control-plane state root must be an exact absolute path.',
      12,
    );
  }
  return {
    root: storageRoot,
    supervisor: path.join(storageRoot, 'control-plane-supervisor.json'),
    initialBootstrapJournal: path.join(
      storageRoot,
      'initial-supervisor-bootstrap',
    ),
    bundles: path.join(storageRoot, 'control-plane-promotion-bundles'),
    artifacts: path.join(storageRoot, 'control-plane-artifacts'),
    approvalCandidates: path.join(
      storageRoot,
      'control-plane-approval-candidates',
    ),
    controlUpdates: path.join(storageRoot, 'control-updates'),
    supervisorHistory: path.join(
      storageRoot,
      'control-plane-supervisor-history',
    ),
    checkpoints: path.join(storageRoot, 'checkpoints'),
    interventions: path.join(storageRoot, 'interventions'),
    sidecarSessions: path.join(storageRoot, 'sidecar-sessions'),
    adoptions: path.join(storageRoot, 'adoptions'),
    operations: path.join(storageRoot, 'operations'),
    localSessions: path.join(storageRoot, 'local-parent-sessions'),
    localArtifacts: path.join(storageRoot, 'local-engine-artifacts'),
  };
}

type BootstrapRootNamespace = 'global' | 'local' | 'operations' | 'unknown';

function classifyBootstrapRootEntry(
  paths: BootstrapPaths,
  entryName: string,
): BootstrapRootNamespace {
  const localNames = new Set([
    path.basename(paths.checkpoints),
    path.basename(paths.interventions),
    path.basename(paths.sidecarSessions),
    path.basename(paths.adoptions),
    path.basename(paths.localSessions),
    path.basename(paths.localArtifacts),
    'maintenance-grants',
    'intervention-engine-artifacts',
  ]);
  if (localNames.has(entryName)) return 'local';
  if (entryName === path.basename(paths.operations)) return 'operations';
  const globalNames = new Set([
    path.basename(paths.supervisor),
    `${path.basename(paths.supervisor)}.pending`,
    path.basename(paths.initialBootstrapJournal),
    path.basename(paths.artifacts),
    path.basename(paths.approvalCandidates),
    path.basename(paths.bundles),
    path.basename(paths.controlUpdates),
    path.basename(paths.supervisorHistory),
  ]);
  return globalNames.has(entryName) ? 'global' : 'unknown';
}

function assertNoOrphanedGlobalControlPlaneState(paths: BootstrapPaths): void {
  const root = fs.lstatSync(paths.root, { throwIfNoEntry: false });
  if (root === undefined) return;
  assertPrivateDirectory(paths.root, 'CONTROL_PLANE_STATE_UNSAFE');
  for (const entry of fs.readdirSync(paths.root, { withFileTypes: true })) {
    const classification = classifyBootstrapRootEntry(paths, entry.name);
    const absolute = path.join(paths.root, entry.name);
    if (classification === 'local') {
      assertPrivateDirectory(absolute, 'CONTROL_PLANE_STATE_UNSAFE');
      continue;
    }
    if (classification === 'operations') {
      assertPrivateDirectory(absolute, 'CONTROL_PLANE_STATE_UNSAFE');
      if (fs.readdirSync(absolute).length === 0) continue;
    }
    throw supervisorCorrupt();
  }
}

function assertBootstrapRepositoryPaths(
  identity: BootstrapRepositoryIdentity,
): void {
  for (const directory of [
    identity.gitCommonDirectory,
    identity.worktreeRoot,
  ]) {
    const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (
      typeof directory !== 'string' ||
      !path.isAbsolute(directory) ||
      path.resolve(directory) !== directory ||
      !stats?.isDirectory() ||
      stats.isSymbolicLink() ||
      fs.realpathSync(directory) !== directory
    ) {
      throw bootstrapRepositoryIdentityInvalid();
    }
  }
  if (
    identity.branchRef !== null &&
    (!isNonEmptyTrimmed(identity.branchRef) ||
      !identity.branchRef.startsWith('refs/heads/') ||
      identity.branchRef.includes('\0') ||
      identity.branchRef.includes('\n'))
  ) {
    throw bootstrapRepositoryIdentityInvalid();
  }
}

function exactBootstrapGitOutput(
  cwd: string,
  argv: readonly string[],
  allowEmpty = false,
): string {
  const executable = process.platform === 'win32' ? 'git' : '/usr/bin/git';
  const result = childProcess.spawnSync(executable, [...argv], {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
      LANG: 'C',
      LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    },
    timeout: PROCESS_TIMEOUT_MS,
    maxBuffer: MAX_STATE_BYTES,
    windowsHide: true,
  });
  if (
    result.error !== undefined ||
    result.signal !== null ||
    result.status !== 0 ||
    typeof result.stdout !== 'string' ||
    Buffer.byteLength(result.stdout) > MAX_STATE_BYTES
  ) {
    throw bootstrapRepositoryIdentityInvalid();
  }
  const output = result.stdout.trim();
  if ((!allowEmpty && output.length === 0) || output.includes('\0')) {
    throw bootstrapRepositoryIdentityInvalid();
  }
  return output;
}

function assertBootstrapRepositoryClean(worktreeRoot: string): void {
  const status = exactBootstrapGitOutput(
    worktreeRoot,
    ['status', '--porcelain=v1', '--untracked-files=all'],
    true,
  );
  if (status.length !== 0) {
    throw trustError(
      'CONTROL_PLANE_BOOTSTRAP_REPOSITORY_DIRTY',
      'Initial control-plane bootstrap requires a clean repository worktree.',
      14,
    );
  }
}

function verifiedProtectedCapabilityManifest(
  worktreeRoot: string,
  revision = 'HEAD',
  requireWorktreeMatch = true,
): VerifiedProtectedCapabilityManifest {
  const raw = exactBootstrapGitOutput(worktreeRoot, [
    'show',
    `${revision}:${PROTECTED_CAPABILITY_MANIFEST_PATH}`,
  ]);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw protectedCapabilityManifestInvalid();
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'entries',
      'kind',
      'manifestPath',
      'schemaVersion',
    ]) ||
    value.kind !== 'protected-capability-manifest.v1' ||
    value.schemaVersion !== 1 ||
    value.manifestPath !== PROTECTED_CAPABILITY_MANIFEST_PATH ||
    !Array.isArray(value.entries) ||
    value.entries.length !== REQUIRED_BOOTSTRAP_PROTECTED_CAPABILITIES.length
  ) {
    throw protectedCapabilityManifestInvalid();
  }
  const tree = readBootstrapHeadTree(worktreeRoot, revision);
  const capabilities: string[] = [];
  const declaredPaths: string[] = [];
  for (const entry of value.entries) {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, [
        'capability',
        'closureDigest',
        'contentDigest',
        'dependencies',
        'entrypoints',
      ]) ||
      typeof entry.capability !== 'string' ||
      !Array.isArray(entry.entrypoints) ||
      entry.entrypoints.length === 0 ||
      !Array.isArray(entry.dependencies) ||
      !isDigest(entry.contentDigest) ||
      !isDigest(entry.closureDigest) ||
      !sortedUniqueProtectedPaths(entry.entrypoints, true) ||
      !sortedUniqueProtectedPaths(entry.dependencies, true) ||
      !bootstrapEntryDigestsMatch(tree, entry)
    ) {
      throw protectedCapabilityManifestInvalid();
    }
    capabilities.push(entry.capability);
    declaredPaths.push(...entry.entrypoints, ...entry.dependencies);
  }
  if (
    canonicalJson(capabilities) !==
    canonicalJson(REQUIRED_BOOTSTRAP_PROTECTED_CAPABILITIES)
  ) {
    throw protectedCapabilityManifestInvalid();
  }
  assertNoBootstrapCaseFoldAliases(declaredPaths);
  if (
    !declaredPaths.some((entry) =>
      matchesBootstrapProtectedPath(PROTECTED_CAPABILITY_MANIFEST_PATH, entry),
    ) ||
    !declaredPaths.some((entry) =>
      matchesBootstrapProtectedPath(
        'packages/workflow-engine/src/adapters/consumer/expense-app/work-registry/protected-capabilities.ts',
        entry,
      ),
    )
  ) {
    throw protectedCapabilityManifestInvalid();
  }
  for (const requiredPath of BUILT_IN_BOOTSTRAP_RUNTIME_PATHS) {
    if (
      !declaredPaths.some((entry) =>
        matchesBootstrapProtectedPath(requiredPath, entry),
      )
    ) {
      throw protectedCapabilityManifestInvalid();
    }
  }
  const bootstrapRuntimeFiles = BUILT_IN_BOOTSTRAP_RUNTIME_PATHS.map(
    (filePath) => {
      const treeEntry = tree.find((entry) => entry.path === filePath);
      if (
        treeEntry?.type !== 'blob' ||
        (treeEntry.mode !== '100644' && treeEntry.mode !== '100755')
      ) {
        throw protectedCapabilityManifestInvalid();
      }
      const mode: '100644' | '100755' = treeEntry.mode;
      const bytes = readBootstrapGitBlob(worktreeRoot, revision, filePath);
      if (requireWorktreeMatch) {
        const worktreeBytes = readClosureFile(
          path.join(worktreeRoot, ...filePath.split('/')),
          mode === '100755' ? 0o755 : 0o644,
        );
        if (!worktreeBytes.equals(bytes)) {
          throw protectedCapabilityManifestInvalid();
        }
      }
      return {
        path: filePath.slice('packages/workflow-engine/'.length),
        mode,
        digest: rawDigest(bytes),
        bytes,
      };
    },
  );
  return {
    payload: value,
    manifestDigest: canonicalDigest(value),
    bootstrapRuntimeFiles,
  };
}

function readBootstrapHeadTree(
  worktreeRoot: string,
  revision = 'HEAD',
): BootstrapProtectedTreeEntry[] {
  const executable = process.platform === 'win32' ? 'git' : '/usr/bin/git';
  const result = childProcess.spawnSync(
    executable,
    ['-c', 'core.quotePath=false', 'ls-tree', '-rz', '--full-tree', revision],
    {
      cwd: worktreeRoot,
      encoding: 'buffer',
      env: {
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        LANG: 'C',
        LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
      },
      timeout: PROCESS_TIMEOUT_MS,
      maxBuffer: MAX_CLOSURE_FILE_BYTES,
      windowsHide: true,
    },
  );
  if (
    result.error !== undefined ||
    result.signal !== null ||
    result.status !== 0 ||
    !Buffer.isBuffer(result.stdout) ||
    result.stdout.length > MAX_CLOSURE_FILE_BYTES
  ) {
    throw protectedCapabilityManifestInvalid();
  }
  const output = result.stdout;
  if (output.length === 0) return [];
  if (output.at(-1) !== 0) throw protectedCapabilityManifestInvalid();
  const text = output.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(output)) {
    throw protectedCapabilityManifestInvalid();
  }
  const entries = text
    .slice(0, -1)
    .split('\0')
    .map((record): BootstrapProtectedTreeEntry => {
      const tab = record.indexOf('\t');
      const metadata = tab === -1 ? [] : record.slice(0, tab).split(' ');
      const filePath = tab === -1 ? '' : record.slice(tab + 1);
      const [mode, type, objectId] = metadata;
      if (
        metadata.length !== 3 ||
        mode === undefined ||
        type === undefined ||
        objectId === undefined ||
        !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(objectId) ||
        !safeProtectedCapabilityPath(filePath, false)
      ) {
        throw protectedCapabilityManifestInvalid();
      }
      return { path: filePath, mode, objectId, type };
    });
  const paths = entries.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length) {
    throw protectedCapabilityManifestInvalid();
  }
  return entries;
}

function readBootstrapGitBlob(
  worktreeRoot: string,
  revision: string,
  filePath: string,
): Buffer {
  if (
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(revision) ||
    !safeProtectedCapabilityPath(filePath, false)
  ) {
    throw protectedCapabilityManifestInvalid();
  }
  const executable = process.platform === 'win32' ? 'git' : '/usr/bin/git';
  const result = childProcess.spawnSync(
    executable,
    ['show', `${revision}:${filePath}`],
    {
      cwd: worktreeRoot,
      encoding: 'buffer',
      env: {
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        LANG: 'C',
        LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
      },
      timeout: PROCESS_TIMEOUT_MS,
      maxBuffer: MAX_CLOSURE_FILE_BYTES,
      windowsHide: true,
    },
  );
  if (
    result.error !== undefined ||
    result.signal !== null ||
    result.status !== 0 ||
    !Buffer.isBuffer(result.stdout) ||
    result.stdout.length > MAX_CLOSURE_FILE_BYTES
  ) {
    throw protectedCapabilityManifestInvalid();
  }
  return result.stdout;
}

function bootstrapEntryDigestsMatch(
  tree: BootstrapProtectedTreeEntry[],
  entry: Record<string, unknown>,
): boolean {
  const entrypoints = entry.entrypoints as string[];
  const dependencies = entry.dependencies as string[];
  assertNoBootstrapCaseFoldAliases([...entrypoints, ...dependencies]);
  const identities = resolveBootstrapClosureIdentities(tree, [
    ...entrypoints,
    ...dependencies,
  ]);
  const contentDigest = canonicalDigest({
    kind: 'protected-capability-content.v1',
    files: identities,
  });
  const closureDigest = canonicalDigest({
    entrypoints,
    dependencies,
    contentDigest,
  });
  return (
    entry.contentDigest === contentDigest &&
    entry.closureDigest === closureDigest
  );
}

function resolveBootstrapClosureIdentities(
  tree: BootstrapProtectedTreeEntry[],
  declaredPaths: string[],
): BootstrapProtectedClosureIdentity[] {
  const identities = new Map<string, BootstrapProtectedClosureIdentity>();
  for (const declaredPath of new Set(declaredPaths)) {
    const matches = tree.filter((entry) =>
      matchesBootstrapProtectedPath(entry.path, declaredPath),
    );
    const protectsManifest = matchesBootstrapProtectedPath(
      PROTECTED_CAPABILITY_MANIFEST_PATH,
      declaredPath,
    );
    if (matches.length === 0 && !protectsManifest) {
      throw protectedCapabilityManifestInvalid();
    }
    if (protectsManifest) {
      identities.set(PROTECTED_CAPABILITY_MANIFEST_PATH, {
        path: PROTECTED_CAPABILITY_MANIFEST_PATH,
        mode: 'manifest-self',
        objectId: 'manifest-self',
      });
    }
    for (const match of matches) {
      if (match.path === PROTECTED_CAPABILITY_MANIFEST_PATH) continue;
      if (
        match.type !== 'blob' ||
        (match.mode !== '100644' && match.mode !== '100755')
      ) {
        throw protectedCapabilityManifestInvalid();
      }
      identities.set(match.path, {
        path: match.path,
        mode: match.mode,
        objectId: match.objectId,
      });
    }
  }
  const resolved = [...identities.values()].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  assertNoBootstrapCaseFoldAliases(resolved.map((entry) => entry.path));
  return resolved;
}

function matchesBootstrapProtectedPath(
  filePath: string,
  policyPath: string,
): boolean {
  const base = policyPath.endsWith('/**')
    ? policyPath.slice(0, -3)
    : policyPath;
  return policyPath.endsWith('/**')
    ? filePath === base || filePath.startsWith(`${base}/`)
    : filePath === policyPath;
}

function assertNoBootstrapCaseFoldAliases(values: readonly string[]): void {
  const aliases = new Map<string, string>();
  for (const value of values) {
    const key = value.toLocaleLowerCase('en-US');
    const previous = aliases.get(key);
    if (previous !== undefined && previous !== value) {
      throw protectedCapabilityManifestInvalid();
    }
    aliases.set(key, value);
  }
}

function sortedUniqueProtectedPaths(
  values: unknown[],
  allowRecursiveSuffix: boolean,
): values is string[] {
  if (
    !values.every((value) =>
      safeProtectedCapabilityPath(value, allowRecursiveSuffix),
    )
  ) {
    return false;
  }
  const sorted = [...new Set(values as string[])].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return canonicalJson(values) === canonicalJson(sorted);
}

function safeProtectedCapabilityPath(
  value: unknown,
  allowRecursiveSuffix: boolean,
): value is string {
  if (typeof value !== 'string') return false;
  const withoutSuffix =
    allowRecursiveSuffix && value.endsWith('/**') ? value.slice(0, -3) : value;
  return (
    value.trim() === value &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
    }) &&
    withoutSuffix.length > 0 &&
    withoutSuffix === withoutSuffix.normalize('NFC') &&
    !path.posix.isAbsolute(withoutSuffix) &&
    !/^[A-Za-z]:[\\/]/.test(withoutSuffix) &&
    !withoutSuffix.startsWith('./') &&
    !withoutSuffix.endsWith('/') &&
    !withoutSuffix.includes('\\') &&
    !/[*?[\]{}]/.test(withoutSuffix) &&
    withoutSuffix
      .split('/')
      .every(
        (part) =>
          part.length > 0 &&
          part !== '.' &&
          part !== '..' &&
          part.toLowerCase() !== '.git',
      )
  );
}

function createBuiltInControlPlaneEngineArtifact(
  sourceDigest: Sha256Digest,
  controlPlaneClosureDigest: Sha256Digest,
  executableDigest: Sha256Digest,
): BootstrapControlPlaneEngineArtifact {
  const selfTest = {
    kind: 'control-plane-self-test.v1',
    healthy: true,
    closureDigest: controlPlaneClosureDigest,
  };
  const payload = {
    kind: 'engine-artifact.v1' as const,
    sourceChangeId: 'repository-default-built-in',
    sourceDigest,
    executableDigest,
    protocolVersion: BUILT_IN_PROTOCOL_VERSION,
    canReadSessionSchemas: [BUILT_IN_SESSION_SCHEMA],
    writesSessionSchema: BUILT_IN_SESSION_SCHEMA,
    policySchemaVersion: BUILT_IN_POLICY_SCHEMA_VERSION,
    smokeReportDigest: canonicalDigest(selfTest),
  };
  return { ...payload, artifactId: canonicalDigest(payload) };
}

function initialGlobalNamespaceState(
  paths: BootstrapPaths,
  expectedArtifactId: Sha256Digest,
): void {
  for (const entry of fs.readdirSync(paths.root, { withFileTypes: true })) {
    const absolute = path.join(paths.root, entry.name);
    const classification = classifyBootstrapRootEntry(paths, entry.name);
    if (
      classification === 'global' &&
      [
        path.basename(paths.approvalCandidates),
        path.basename(paths.bundles),
        path.basename(paths.controlUpdates),
      ].includes(entry.name)
    ) {
      throw bootstrapStateNotEmpty();
    }
    if (entry.name === path.basename(paths.artifacts)) {
      assertPrivateDirectory(absolute, 'CONTROL_PLANE_BOOTSTRAP_STATE_UNSAFE');
      const children = fs.readdirSync(absolute);
      if (
        children.length > 1 ||
        (children.length === 1 &&
          children[0] !== expectedArtifactId.slice('sha256:'.length))
      ) {
        throw bootstrapArtifactMismatch();
      }
      continue;
    }
    if (entry.name === path.basename(paths.initialBootstrapJournal)) {
      assertPrivateDirectory(
        absolute,
        'CONTROL_PLANE_BOOTSTRAP_JOURNAL_CORRUPT',
      );
      continue;
    }
    if (
      entry.name === path.basename(paths.supervisor) ||
      entry.name === `${path.basename(paths.supervisor)}.pending`
    ) {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw initialBootstrapJournalCorrupt();
      }
      continue;
    }
    if (classification === 'operations') {
      assertPrivateDirectory(absolute, 'CONTROL_PLANE_BOOTSTRAP_STATE_UNSAFE');
      if (fs.readdirSync(absolute).length !== 0) throw bootstrapStateNotEmpty();
      continue;
    }
    if (classification !== 'local') throw bootstrapStateNotEmpty();
    assertPrivateDirectory(absolute, 'CONTROL_PLANE_BOOTSTRAP_STATE_UNSAFE');
  }
}

function ensureInitialStateRoot(storageRoot: string): void {
  try {
    fs.mkdirSync(storageRoot, {
      recursive: true,
      mode: PRIVATE_DIRECTORY_MODE,
    });
  } catch {
    throw trustError(
      'CONTROL_PLANE_BOOTSTRAP_STATE_UNSAFE',
      'Initial control-plane state root could not be created safely.',
      12,
    );
  }
  assertPrivateDirectory(storageRoot, 'CONTROL_PLANE_BOOTSTRAP_STATE_UNSAFE');
}

const INITIAL_BOOTSTRAP_PHASE_FILES: Record<
  InitialSupervisorBootstrapPhase,
  string
> = {
  PREPARED: '00-prepared.json',
  ARTIFACT_MATERIALIZED: '01-artifact-materialized.json',
  SUPERVISOR_PUBLISHED: '02-supervisor-published.json',
};

const INITIAL_BOOTSTRAP_PHASES = [
  'PREPARED',
  'ARTIFACT_MATERIALIZED',
  'SUPERVISOR_PUBLISHED',
] as const satisfies readonly InitialSupervisorBootstrapPhase[];

function ensureInitialBootstrapJournalDirectory(paths: BootstrapPaths): void {
  const existing = fs.lstatSync(paths.initialBootstrapJournal, {
    throwIfNoEntry: false,
  });
  if (existing === undefined) {
    try {
      fs.mkdirSync(paths.initialBootstrapJournal, {
        mode: PRIVATE_DIRECTORY_MODE,
      });
      fsyncDirectory(paths.root);
    } catch {
      throw initialBootstrapJournalCorrupt();
    }
  }
  assertPrivateDirectory(
    paths.initialBootstrapJournal,
    'CONTROL_PLANE_BOOTSTRAP_JOURNAL_CORRUPT',
  );
}

function assertInitialBootstrapJournalInventory(
  paths: BootstrapPaths,
): InitialSupervisorBootstrapJournalProgress {
  const entries = fs.readdirSync(paths.initialBootstrapJournal, {
    withFileTypes: true,
  });
  const names = new Set(entries.map((entry) => entry.name));
  const allowed = new Set(
    Object.values(INITIAL_BOOTSTRAP_PHASE_FILES).flatMap((fileName) => [
      fileName,
      `${fileName}.pending`,
    ]),
  );
  if (
    entries.some(
      (entry) =>
        !allowed.has(entry.name) || !entry.isFile() || entry.isSymbolicLink(),
    )
  ) {
    throw initialBootstrapJournalCorrupt();
  }
  let completed = 0;
  let pendingCount = 0;
  let pendingPhase: InitialSupervisorBootstrapPhase | null = null;
  for (let index = 0; index < INITIAL_BOOTSTRAP_PHASES.length; index += 1) {
    const fileName =
      INITIAL_BOOTSTRAP_PHASE_FILES[INITIAL_BOOTSTRAP_PHASES[index]];
    const hasFinal = names.has(fileName);
    const hasPending = names.has(`${fileName}.pending`);
    if (hasFinal && hasPending) throw initialBootstrapJournalCorrupt();
    if (hasFinal) {
      if (index !== completed || pendingCount !== 0) {
        throw initialBootstrapJournalCorrupt();
      }
      completed += 1;
    }
    if (hasPending) {
      if (index !== completed || pendingCount !== 0) {
        throw initialBootstrapJournalCorrupt();
      }
      pendingCount += 1;
      pendingPhase = INITIAL_BOOTSTRAP_PHASES[index];
    }
  }
  if (pendingCount > 1) throw initialBootstrapJournalCorrupt();

  const preparedExists =
    names.has(INITIAL_BOOTSTRAP_PHASE_FILES.PREPARED) ||
    names.has(`${INITIAL_BOOTSTRAP_PHASE_FILES.PREPARED}.pending`);
  if (!preparedExists) {
    if (
      fs.lstatSync(paths.artifacts, { throwIfNoEntry: false }) !== undefined ||
      fs.lstatSync(paths.supervisor, { throwIfNoEntry: false }) !== undefined ||
      fs.lstatSync(`${paths.supervisor}.pending`, {
        throwIfNoEntry: false,
      }) !== undefined
    ) {
      throw bootstrapStateNotEmpty();
    }
  }
  const artifactExists =
    fs.lstatSync(paths.artifacts, { throwIfNoEntry: false }) !== undefined;
  const supervisorExists =
    fs.lstatSync(paths.supervisor, { throwIfNoEntry: false }) !== undefined;
  const supervisorPendingExists =
    fs.lstatSync(`${paths.supervisor}.pending`, {
      throwIfNoEntry: false,
    }) !== undefined;
  if (
    (pendingPhase === 'PREPARED' &&
      (artifactExists || supervisorExists || supervisorPendingExists)) ||
    (completed < 2 && (supervisorExists || supervisorPendingExists))
  ) {
    throw initialBootstrapJournalCorrupt();
  }
  return { completedPhases: completed, pendingPhase };
}

function resolveInitialBootstrapTimestamp(
  paths: BootstrapPaths,
  provenance: InitialSupervisorProvenance,
  builtInClosureDigest: Sha256Digest,
  protectedManifestDigest: Sha256Digest,
  activeArtifact: BootstrapControlPlaneSupervisorState['activeArtifact'],
  requestedTimestamp: string,
): string {
  const preparedPath = path.join(
    paths.initialBootstrapJournal,
    INITIAL_BOOTSTRAP_PHASE_FILES.PREPARED,
  );
  const candidatePath =
    fs.lstatSync(preparedPath, { throwIfNoEntry: false }) !== undefined
      ? preparedPath
      : fs.lstatSync(`${preparedPath}.pending`, { throwIfNoEntry: false }) !==
          undefined
        ? `${preparedPath}.pending`
        : null;
  if (candidatePath === null) return requestedTimestamp;
  const candidate = readInitialBootstrapJournalRecord(candidatePath);
  const initializedAt = candidate.initializedAt;
  const state = createInitialSupervisorState(
    provenance.repositoryId,
    activeArtifact,
    initializedAt,
  );
  const expected = createInitialBootstrapJournalRecord(
    'PREPARED',
    provenance,
    initializedAt,
    builtInClosureDigest,
    protectedManifestDigest,
    activeArtifact,
    state.recordDigest,
    null,
  );
  if (canonicalJson(candidate) !== canonicalJson(expected)) {
    throw initialBootstrapJournalCorrupt();
  }
  return initializedAt;
}

function createInitialSupervisorState(
  repositoryId: string,
  activeArtifact: BootstrapControlPlaneSupervisorState['activeArtifact'],
  updatedAt: string,
): BootstrapControlPlaneSupervisorState {
  const payload = {
    kind: 'control-plane-supervisor-state.v1' as const,
    repositoryId,
    activeArtifact,
    generation: 1,
    transition: null,
    updatedAt,
  };
  return { ...payload, recordDigest: canonicalDigest(payload) };
}

function createInitialSupervisorBootstrapJournal(
  provenance: InitialSupervisorProvenance,
  initializedAt: string,
  builtInClosureDigest: Sha256Digest,
  protectedManifestDigest: Sha256Digest,
  activeArtifact: BootstrapControlPlaneSupervisorState['activeArtifact'],
  supervisorRecordDigest: Sha256Digest,
): Record<
  InitialSupervisorBootstrapPhase,
  InitialSupervisorBootstrapJournalRecord
> {
  const prepared = createInitialBootstrapJournalRecord(
    'PREPARED',
    provenance,
    initializedAt,
    builtInClosureDigest,
    protectedManifestDigest,
    activeArtifact,
    supervisorRecordDigest,
    null,
  );
  const materialized = createInitialBootstrapJournalRecord(
    'ARTIFACT_MATERIALIZED',
    provenance,
    initializedAt,
    builtInClosureDigest,
    protectedManifestDigest,
    activeArtifact,
    supervisorRecordDigest,
    prepared.recordDigest,
  );
  const published = createInitialBootstrapJournalRecord(
    'SUPERVISOR_PUBLISHED',
    provenance,
    initializedAt,
    builtInClosureDigest,
    protectedManifestDigest,
    activeArtifact,
    supervisorRecordDigest,
    materialized.recordDigest,
  );
  return {
    PREPARED: prepared,
    ARTIFACT_MATERIALIZED: materialized,
    SUPERVISOR_PUBLISHED: published,
  };
}

function createInitialBootstrapJournalRecord(
  phase: InitialSupervisorBootstrapPhase,
  provenance: InitialSupervisorProvenance,
  initializedAt: string,
  builtInClosureDigest: Sha256Digest,
  protectedManifestDigest: Sha256Digest,
  activeArtifact: BootstrapControlPlaneSupervisorState['activeArtifact'],
  supervisorRecordDigest: Sha256Digest,
  previousPhaseDigest: Sha256Digest | null,
): InitialSupervisorBootstrapJournalRecord {
  const payload = {
    kind: 'initial-supervisor-bootstrap-journal.v1' as const,
    phase,
    provenance,
    initializedAt,
    builtInClosureDigest,
    protectedManifestDigest,
    activeArtifact,
    supervisorRecordDigest,
    previousPhaseDigest,
  };
  return { ...payload, recordDigest: canonicalDigest(payload) };
}

function publishInitialBootstrapJournalPhase(
  paths: BootstrapPaths,
  record: InitialSupervisorBootstrapJournalRecord,
): void {
  publishExactPrivateFile(
    path.join(
      paths.initialBootstrapJournal,
      INITIAL_BOOTSTRAP_PHASE_FILES[record.phase],
    ),
    `${canonicalJson(record)}\n`,
    PRIVATE_FILE_MODE,
    initialBootstrapJournalCorrupt,
  );
}

function assertExistingInitialBootstrapJournalRecords(
  paths: BootstrapPaths,
  expected: Record<
    InitialSupervisorBootstrapPhase,
    InitialSupervisorBootstrapJournalRecord
  >,
): void {
  for (const phase of INITIAL_BOOTSTRAP_PHASES) {
    const finalPath = path.join(
      paths.initialBootstrapJournal,
      INITIAL_BOOTSTRAP_PHASE_FILES[phase],
    );
    const candidatePath =
      fs.lstatSync(finalPath, { throwIfNoEntry: false }) !== undefined
        ? finalPath
        : fs.lstatSync(`${finalPath}.pending`, { throwIfNoEntry: false }) !==
            undefined
          ? `${finalPath}.pending`
          : null;
    if (candidatePath === null) continue;
    const observed = readInitialBootstrapJournalRecord(candidatePath);
    if (canonicalJson(observed) !== canonicalJson(expected[phase])) {
      throw initialBootstrapJournalCorrupt();
    }
  }
}

function assertInitialBootstrapJournalComplete(
  paths: BootstrapPaths,
  expected: Record<
    InitialSupervisorBootstrapPhase,
    InitialSupervisorBootstrapJournalRecord
  >,
): void {
  assertInitialBootstrapJournalInventory(paths);
  const entries = fs.readdirSync(paths.initialBootstrapJournal).sort();
  const expectedNames = INITIAL_BOOTSTRAP_PHASES.map(
    (phase) => INITIAL_BOOTSTRAP_PHASE_FILES[phase],
  ).sort();
  if (canonicalJson(entries) !== canonicalJson(expectedNames)) {
    throw initialBootstrapJournalCorrupt();
  }
  for (const phase of INITIAL_BOOTSTRAP_PHASES) {
    const record = readInitialBootstrapJournalRecord(
      path.join(
        paths.initialBootstrapJournal,
        INITIAL_BOOTSTRAP_PHASE_FILES[phase],
      ),
    );
    if (canonicalJson(record) !== canonicalJson(expected[phase])) {
      throw initialBootstrapJournalCorrupt();
    }
  }
}

function assertInitialBootstrapTerminalSelection(
  paths: BootstrapPaths,
  supervisor: BootstrapControlPlaneSupervisorState,
): void {
  if (supervisor.generation !== 1) throw supervisorNotTerminal();
  assertPrivateDirectory(
    paths.initialBootstrapJournal,
    'CONTROL_PLANE_BOOTSTRAP_JOURNAL_CORRUPT',
  );
  const progress = assertInitialBootstrapJournalInventory(paths);
  if (progress.completedPhases !== 3 || progress.pendingPhase !== null) {
    throw supervisorNotTerminal();
  }
  const records = INITIAL_BOOTSTRAP_PHASES.map((phase) =>
    readInitialBootstrapJournalRecord(
      path.join(
        paths.initialBootstrapJournal,
        INITIAL_BOOTSTRAP_PHASE_FILES[phase],
      ),
    ),
  );
  const [prepared, materialized, published] = records;
  if (
    prepared.phase !== 'PREPARED' ||
    prepared.previousPhaseDigest !== null ||
    materialized.phase !== 'ARTIFACT_MATERIALIZED' ||
    materialized.previousPhaseDigest !== prepared.recordDigest ||
    published.phase !== 'SUPERVISOR_PUBLISHED' ||
    published.previousPhaseDigest !== materialized.recordDigest ||
    records.some(
      (record) =>
        canonicalJson(initialBootstrapStableRecord(record)) !==
        canonicalJson(initialBootstrapStableRecord(prepared)),
    ) ||
    prepared.supervisorRecordDigest !== supervisor.recordDigest ||
    prepared.provenance.repositoryId !== supervisor.repositoryId ||
    prepared.initializedAt !== supervisor.updatedAt ||
    prepared.protectedManifestDigest !==
      supervisor.activeArtifact.closureDigest ||
    canonicalJson(prepared.activeArtifact) !==
      canonicalJson(supervisor.activeArtifact)
  ) {
    throw supervisorNotTerminal();
  }

  const provenance = prepared.provenance;
  const packageSuffix = path.join('packages', 'workflow-engine');
  const worktreeRoot = path.dirname(path.dirname(provenance.packageRoot));
  if (
    provenance.packageRoot !== path.join(worktreeRoot, packageSuffix) ||
    provenance.remoteBaseOid !== provenance.headOid ||
    provenance.branchRef !==
      provenance.remoteBaseRef.replace(
        /^refs\/remotes\/origin\//,
        'refs/heads/',
      )
  ) {
    throw supervisorNotTerminal();
  }
  const gitCommonDirectory = fs.realpathSync(
    exactBootstrapGitOutput(worktreeRoot, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ]),
  );
  if (bootstrapInterventionStateRoot(gitCommonDirectory) !== paths.root) {
    throw supervisorNotTerminal();
  }
  const identity: BootstrapRepositoryIdentity = {
    gitCommonDirectory,
    worktreeRoot,
    branchRef: provenance.branchRef,
  };
  if (
    verifyBootstrapRepositoryIdentityAt(identity, provenance.headOid) !==
    supervisor.repositoryId
  ) {
    throw supervisorNotTerminal();
  }
  const trustedTreeOid = exactBootstrapGitOutput(worktreeRoot, [
    'rev-parse',
    '--verify',
    `${provenance.headOid}^{tree}`,
  ]);
  const remoteTip = readBootstrapRemoteBaseOid(
    worktreeRoot,
    provenance.remoteBaseRef,
  );
  if (
    trustedTreeOid !== provenance.treeOid ||
    !bootstrapCommitIsAncestor(worktreeRoot, provenance.headOid, remoteTip)
  ) {
    throw supervisorNotTerminal();
  }

  const storedManifestPath = path.join(
    paths.artifacts,
    supervisor.activeArtifact.artifactId.slice('sha256:'.length),
    'built-in-engine-closure.json',
  );
  const manifestBytes = readExactPrivateFile(
    storedManifestPath,
    PRIVATE_FILE_MODE,
    MAX_STATE_BYTES,
  );
  const committedManifestBytes = readBootstrapGitBlob(
    worktreeRoot,
    provenance.headOid,
    'packages/workflow-engine/bootstrap/built-in-engine-closure.json',
  );
  if (
    !manifestBytes.equals(committedManifestBytes) ||
    rawDigest(manifestBytes) !== prepared.builtInClosureDigest
  ) {
    throw supervisorNotTerminal();
  }
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw supervisorNotTerminal();
  }
  if (
    `${JSON.stringify(manifestValue, null, 2)}\n` !==
    manifestBytes.toString('utf8')
  ) {
    throw supervisorNotTerminal();
  }
  const manifest = verifyClosureManifest(manifestValue);
  const trustedTree = readBootstrapHeadTree(worktreeRoot, provenance.headOid);
  const closureFiles = manifest.files.map((entry) => {
    const repositoryPath = `packages/workflow-engine/${entry.path}`;
    const bytes = readBootstrapGitBlob(
      worktreeRoot,
      provenance.headOid,
      repositoryPath,
    );
    const treeEntry = trustedTree.find(
      (candidate) => candidate.path === repositoryPath,
    );
    if (
      treeEntry?.type !== 'blob' ||
      treeEntry.mode !== entry.mode ||
      rawDigest(bytes) !== entry.digest
    ) {
      throw supervisorNotTerminal();
    }
    return { ...entry, bytes };
  });
  const pinBytes = readBootstrapGitBlob(
    worktreeRoot,
    provenance.headOid,
    'packages/workflow-engine/bootstrap/built-in-engine-closure-pin.ts',
  ).toString('utf8');
  const pinnedDigests = [
    ...pinBytes.matchAll(/'((?:sha256:)[0-9a-f]{64})'/g),
  ].map((match) => match[1]);
  if (
    pinnedDigests.length !== 1 ||
    pinnedDigests[0] !== prepared.builtInClosureDigest
  ) {
    throw supervisorNotTerminal();
  }
  const protectedManifest = verifiedProtectedCapabilityManifest(
    worktreeRoot,
    provenance.headOid,
    false,
  );
  if (protectedManifest.manifestDigest !== prepared.protectedManifestDigest) {
    throw supervisorNotTerminal();
  }
  const closure: VerifiedBuiltInEngineClosure = {
    manifest,
    manifestBytes,
    manifestDigest: prepared.builtInClosureDigest,
    files: closureFiles,
  };
  const executableBytes = Buffer.from(
    builtInSupervisorExecutableSource(
      prepared.builtInClosureDigest,
      prepared.protectedManifestDigest,
      manifest.entrypoint,
      protectedManifest.bootstrapRuntimeFiles,
    ),
  );
  const artifact = createBuiltInControlPlaneEngineArtifact(
    prepared.builtInClosureDigest,
    prepared.protectedManifestDigest,
    rawDigest(executableBytes),
  );
  if (
    artifact.artifactId !== supervisor.activeArtifact.artifactId ||
    artifact.executableDigest !== supervisor.activeArtifact.executableDigest
  ) {
    throw supervisorNotTerminal();
  }
  assertMaterializedBuiltInClosure(
    paths,
    closure,
    protectedManifest.bootstrapRuntimeFiles,
    artifact,
    executableBytes,
  );
  if (
    readBootstrapRemoteBaseOid(worktreeRoot, provenance.remoteBaseRef) !==
    remoteTip
  ) {
    throw supervisorNotTerminal();
  }
}

function initialBootstrapStableRecord(
  record: InitialSupervisorBootstrapJournalRecord,
): Omit<
  InitialSupervisorBootstrapJournalRecord,
  'phase' | 'previousPhaseDigest' | 'recordDigest'
> {
  const {
    phase: _phase,
    previousPhaseDigest: _previous,
    recordDigest: _digest,
    ...stable
  } = record;
  return stable;
}

function bootstrapCommitIsAncestor(
  worktreeRoot: string,
  ancestor: string,
  descendant: string,
): boolean {
  if (
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(ancestor) ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(descendant)
  ) {
    return false;
  }
  const executable = process.platform === 'win32' ? 'git' : '/usr/bin/git';
  const result = childProcess.spawnSync(
    executable,
    ['merge-base', '--is-ancestor', ancestor, descendant],
    {
      cwd: worktreeRoot,
      encoding: 'utf8',
      env: {
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        LANG: 'C',
        LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
      },
      timeout: PROCESS_TIMEOUT_MS,
      maxBuffer: MAX_STATE_BYTES,
      windowsHide: true,
    },
  );
  return (
    result.error === undefined && result.signal === null && result.status === 0
  );
}

function readInitialBootstrapJournalRecord(
  filePath: string,
): InitialSupervisorBootstrapJournalRecord {
  const value = readCanonicalPrivateRecord(
    filePath,
    initialBootstrapJournalCorrupt,
  );
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'activeArtifact',
      'builtInClosureDigest',
      'initializedAt',
      'kind',
      'phase',
      'previousPhaseDigest',
      'protectedManifestDigest',
      'provenance',
      'recordDigest',
      'supervisorRecordDigest',
    ]) ||
    value.kind !== 'initial-supervisor-bootstrap-journal.v1' ||
    !INITIAL_BOOTSTRAP_PHASES.includes(
      value.phase as InitialSupervisorBootstrapPhase,
    ) ||
    !isCanonicalIso(value.initializedAt) ||
    !isDigest(value.builtInClosureDigest) ||
    !isDigest(value.protectedManifestDigest) ||
    !isDigest(value.supervisorRecordDigest) ||
    (value.previousPhaseDigest !== null &&
      !isDigest(value.previousPhaseDigest)) ||
    !isRecord(value.provenance) ||
    !hasExactKeys(value.provenance, [
      'branchRef',
      'headOid',
      'packageRoot',
      'remoteBaseOid',
      'remoteBaseRef',
      'repositoryId',
      'treeOid',
    ]) ||
    !isNonEmptyTrimmed(value.provenance.repositoryId) ||
    !isNonEmptyTrimmed(value.provenance.branchRef) ||
    !isNonEmptyTrimmed(value.provenance.remoteBaseRef) ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(
      String(value.provenance.remoteBaseOid),
    ) ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(String(value.provenance.headOid)) ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(String(value.provenance.treeOid)) ||
    !isNonEmptyTrimmed(value.provenance.packageRoot) ||
    !isRecord(value.activeArtifact) ||
    !verifyRecordDigest(value)
  ) {
    throw initialBootstrapJournalCorrupt();
  }
  return value as unknown as InitialSupervisorBootstrapJournalRecord;
}

function materializeBuiltInClosure(
  paths: BootstrapPaths,
  closure: VerifiedBuiltInEngineClosure,
  protectedManifest: VerifiedProtectedCapabilityManifest,
  artifact: BootstrapControlPlaneEngineArtifact,
  executableBytes: Buffer,
): void {
  const artifactDirectory = path.join(
    paths.artifacts,
    artifact.artifactId.slice('sha256:'.length),
  );
  const closureDirectory = path.join(artifactDirectory, 'closure');
  ensurePrivateArtifactDirectory(paths.artifacts);
  ensurePrivateArtifactDirectory(artifactDirectory);
  ensurePrivateArtifactDirectory(closureDirectory);
  publishExactPrivateFile(
    path.join(artifactDirectory, 'built-in-engine-closure.json'),
    closure.manifestBytes,
    PRIVATE_FILE_MODE,
    bootstrapArtifactMismatch,
  );
  for (const entry of closure.files) {
    const target = path.join(closureDirectory, ...entry.path.split('/'));
    ensurePrivateDescendantDirectories(closureDirectory, path.dirname(target));
    publishExactPrivateFile(
      target,
      entry.bytes,
      PRIVATE_FILE_MODE,
      bootstrapArtifactMismatch,
    );
  }
  for (const entry of protectedManifest.bootstrapRuntimeFiles) {
    const target = path.join(closureDirectory, ...entry.path.split('/'));
    ensurePrivateDescendantDirectories(closureDirectory, path.dirname(target));
    publishExactPrivateFile(
      target,
      entry.bytes,
      PRIVATE_FILE_MODE,
      bootstrapArtifactMismatch,
    );
  }
  publishExactPrivateFile(
    path.join(artifactDirectory, 'engine-artifact.json'),
    `${canonicalJson(artifact)}\n`,
    PRIVATE_FILE_MODE,
    bootstrapArtifactMismatch,
  );
  publishExactPrivateFile(
    path.join(artifactDirectory, 'engine'),
    executableBytes,
    PRIVATE_EXECUTABLE_MODE,
    bootstrapArtifactMismatch,
  );
  assertMaterializedBuiltInClosure(
    paths,
    closure,
    protectedManifest.bootstrapRuntimeFiles,
    artifact,
    executableBytes,
  );
}

function assertMaterializedBuiltInClosure(
  paths: BootstrapPaths,
  closure: VerifiedBuiltInEngineClosure,
  bootstrapRuntimeFiles: VerifiedProtectedCapabilityManifest['bootstrapRuntimeFiles'],
  artifact: BootstrapControlPlaneEngineArtifact,
  executableBytes: Buffer,
): void {
  assertPrivateDirectory(
    paths.artifacts,
    'CONTROL_PLANE_BOOTSTRAP_STATE_UNSAFE',
  );
  const artifactDirectory = path.join(
    paths.artifacts,
    artifact.artifactId.slice('sha256:'.length),
  );
  const closureDirectory = path.join(artifactDirectory, 'closure');
  assertPrivateDirectory(
    artifactDirectory,
    'CONTROL_PLANE_BOOTSTRAP_ARTIFACT_MISMATCH',
  );
  assertPrivateDirectory(
    closureDirectory,
    'CONTROL_PLANE_BOOTSTRAP_ARTIFACT_MISMATCH',
  );
  const topLevel = fs.readdirSync(artifactDirectory).sort();
  if (
    canonicalJson(topLevel) !==
    canonicalJson(
      [
        'built-in-engine-closure.json',
        'closure',
        'engine',
        'engine-artifact.json',
      ].sort(),
    )
  ) {
    throw bootstrapArtifactMismatch();
  }
  const manifestBytes = readExactPrivateFile(
    path.join(artifactDirectory, 'built-in-engine-closure.json'),
    PRIVATE_FILE_MODE,
    MAX_STATE_BYTES,
  );
  if (!manifestBytes.equals(closure.manifestBytes)) {
    throw bootstrapArtifactMismatch();
  }
  const observedFiles = listPrivateClosureFiles(closureDirectory);
  const expectedFiles = [
    ...closure.manifest.files.map((entry) => entry.path),
    ...bootstrapRuntimeFiles.map((entry) => entry.path),
  ].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  if (canonicalJson(observedFiles) !== canonicalJson(expectedFiles)) {
    throw bootstrapArtifactMismatch();
  }
  for (const entry of closure.manifest.files) {
    const copiedBytes = readExactPrivateFile(
      path.join(closureDirectory, ...entry.path.split('/')),
      PRIVATE_FILE_MODE,
      MAX_CLOSURE_FILE_BYTES,
    );
    if (rawDigest(copiedBytes) !== entry.digest) {
      throw bootstrapArtifactMismatch();
    }
  }
  for (const entry of bootstrapRuntimeFiles) {
    const copiedBytes = readExactPrivateFile(
      path.join(closureDirectory, ...entry.path.split('/')),
      PRIVATE_FILE_MODE,
      MAX_CLOSURE_FILE_BYTES,
    );
    if (rawDigest(copiedBytes) !== entry.digest) {
      throw bootstrapArtifactMismatch();
    }
  }
  const persistedArtifact = readBuiltInEngineArtifactRecord(
    path.join(artifactDirectory, 'engine-artifact.json'),
  );
  if (canonicalJson(persistedArtifact) !== canonicalJson(artifact)) {
    throw bootstrapArtifactMismatch();
  }
  const persistedExecutable = readExactPrivateFile(
    path.join(artifactDirectory, 'engine'),
    PRIVATE_EXECUTABLE_MODE,
    MAX_EXECUTABLE_BYTES,
  );
  if (!persistedExecutable.equals(executableBytes)) {
    throw bootstrapArtifactMismatch();
  }
}

function assertBuiltInControlPlaneEngineArtifact(
  paths: BootstrapPaths,
  supervisor: BootstrapControlPlaneSupervisorState,
  artifact: BootstrapControlPlaneEngineArtifact,
  closure: VerifiedBuiltInEngineClosure,
  protectedManifest: VerifiedProtectedCapabilityManifest,
): void {
  const executableBytes = Buffer.from(
    builtInSupervisorExecutableSource(
      closure.manifestDigest,
      supervisor.activeArtifact.closureDigest,
      closure.manifest.entrypoint,
      protectedManifest.bootstrapRuntimeFiles,
    ),
  );
  assertMaterializedBuiltInClosure(
    paths,
    closure,
    protectedManifest.bootstrapRuntimeFiles,
    artifact,
    executableBytes,
  );
}

function readBuiltInEngineArtifactRecord(
  filePath: string,
): BootstrapControlPlaneEngineArtifact {
  const value = readCanonicalPrivateRecord(filePath, bootstrapArtifactMismatch);
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'artifactId',
      'canReadSessionSchemas',
      'executableDigest',
      'kind',
      'policySchemaVersion',
      'protocolVersion',
      'smokeReportDigest',
      'sourceChangeId',
      'sourceDigest',
      'writesSessionSchema',
    ]) ||
    value.kind !== 'engine-artifact.v1' ||
    !isNonEmptyTrimmed(value.sourceChangeId) ||
    !isDigest(value.sourceDigest) ||
    !isDigest(value.executableDigest) ||
    !Number.isSafeInteger(value.protocolVersion) ||
    Number(value.protocolVersion) < 1 ||
    !Array.isArray(value.canReadSessionSchemas) ||
    !value.canReadSessionSchemas.every(isNonEmptyTrimmed) ||
    canonicalJson(value.canReadSessionSchemas) !==
      canonicalJson(
        [...new Set(value.canReadSessionSchemas)].sort((left, right) =>
          left < right ? -1 : left > right ? 1 : 0,
        ),
      ) ||
    !isNonEmptyTrimmed(value.writesSessionSchema) ||
    !value.canReadSessionSchemas.includes(value.writesSessionSchema) ||
    !Number.isSafeInteger(value.policySchemaVersion) ||
    Number(value.policySchemaVersion) < 1 ||
    !isDigest(value.smokeReportDigest) ||
    !isDigest(value.artifactId)
  ) {
    throw bootstrapArtifactMismatch();
  }
  const { artifactId, ...payload } = value;
  if (artifactId !== canonicalDigest(payload))
    throw bootstrapArtifactMismatch();
  return value as unknown as BootstrapControlPlaneEngineArtifact;
}

function ensurePrivateArtifactDirectory(directory: string): void {
  const existing = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (existing === undefined) {
    try {
      fs.mkdirSync(directory, { mode: PRIVATE_DIRECTORY_MODE });
    } catch {
      throw bootstrapArtifactMismatch();
    }
    fsyncDirectory(path.dirname(directory));
  }
  assertPrivateDirectory(
    directory,
    'CONTROL_PLANE_BOOTSTRAP_ARTIFACT_MISMATCH',
  );
}

function ensurePrivateDescendantDirectories(
  root: string,
  target: string,
): void {
  const relative = path.relative(root, target);
  if (relative === '') return;
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw bootstrapArtifactMismatch();
  }
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const stats = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stats === undefined) ensurePrivateArtifactDirectory(current);
    else
      assertPrivateDirectory(
        current,
        'CONTROL_PLANE_BOOTSTRAP_ARTIFACT_MISMATCH',
      );
  }
}

function publishExactPrivateFile(
  filePath: string,
  content: string | Buffer,
  mode: number,
  corrupt: () => Error,
): void {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const pendingPath = `${filePath}.pending`;
  const existing = fs.lstatSync(filePath, { throwIfNoEntry: false });
  const pending = fs.lstatSync(pendingPath, { throwIfNoEntry: false });
  if (existing !== undefined) {
    if (pending !== undefined) throw corrupt();
    let observed: Buffer;
    try {
      observed = readExactPrivateFile(
        filePath,
        mode,
        Math.max(bytes.length, 1),
      );
    } catch {
      throw corrupt();
    }
    if (!observed.equals(bytes)) throw corrupt();
    return;
  }
  if (pending !== undefined) {
    let observed: Buffer;
    try {
      observed = readExactPrivateFile(
        pendingPath,
        mode,
        Math.max(bytes.length, 1),
      );
    } catch {
      throw corrupt();
    }
    if (!observed.equals(bytes)) throw corrupt();
    try {
      fs.renameSync(pendingPath, filePath);
      fsyncDirectory(path.dirname(filePath));
    } catch {
      throw corrupt();
    }
    return;
  }
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      pendingPath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      mode,
    );
    fs.fchmodSync(descriptor, mode);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      (opened.mode & 0o777) !== mode ||
      opened.size !== bytes.length
    ) {
      throw corrupt();
    }
  } catch {
    throw corrupt();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  try {
    fs.renameSync(pendingPath, filePath);
    fsyncDirectory(path.dirname(filePath));
  } catch {
    throw corrupt();
  }
}

function readExactPrivateFile(
  filePath: string,
  mode: number,
  maximumBytes: number,
): Buffer {
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (
    !stats?.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (stats.mode & 0o777) !== mode ||
    stats.size < 1 ||
    stats.size > maximumBytes ||
    fs.realpathSync(filePath) !== filePath
  ) {
    throw bootstrapArtifactMismatch();
  }
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const opened = fs.fstatSync(descriptor);
    const bytes = fs.readFileSync(descriptor);
    if (
      opened.dev !== stats.dev ||
      opened.ino !== stats.ino ||
      opened.size !== stats.size ||
      bytes.length !== stats.size
    ) {
      throw bootstrapArtifactMismatch();
    }
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

function listPrivateClosureFiles(
  directory: string,
  root = directory,
): string[] {
  assertPrivateDirectory(
    directory,
    'CONTROL_PLANE_BOOTSTRAP_ARTIFACT_MISMATCH',
  );
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw bootstrapArtifactMismatch();
    if (entry.isDirectory()) {
      files.push(...listPrivateClosureFiles(absolute, root));
    } else if (entry.isFile()) {
      files.push(path.relative(root, absolute).split(path.sep).join('/'));
    } else {
      throw bootstrapArtifactMismatch();
    }
  }
  return files.sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function validInterventionCheckpoint(
  checkpoint: Record<string, unknown>,
  parentChangeId: string,
): boolean {
  if (
    !hasExactKeys(checkpoint, [
      'baseOid',
      'checkpointId',
      'createdAt',
      'engineDigest',
      'kind',
      'parentChangeId',
      'pendingIntentDigest',
      'policyDigest',
      'sessionStateDigest',
      'trackedTreeDigest',
      'untrackedBundleDigest',
      'worktreeFingerprint',
    ]) ||
    checkpoint.kind !== 'harness-wip-checkpoint.v1' ||
    checkpoint.parentChangeId !== parentChangeId ||
    typeof checkpoint.baseOid !== 'string' ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(checkpoint.baseOid) ||
    !isCanonicalIso(checkpoint.createdAt)
  ) {
    return false;
  }
  for (const key of [
    'checkpointId',
    'engineDigest',
    'pendingIntentDigest',
    'policyDigest',
    'sessionStateDigest',
    'trackedTreeDigest',
    'untrackedBundleDigest',
    'worktreeFingerprint',
  ]) {
    if (!isDigest(checkpoint[key])) return false;
  }
  const { checkpointId, ...payload } = checkpoint;
  return checkpointId === canonicalDigest(payload);
}

function validInterventionChildWorkspace(
  metadata: Record<string, unknown>,
  parentWorkspacePath: string,
  parentChangeId: string,
  interventionChangeId: string,
  checkpointId: string,
  baseOid: string,
): boolean {
  if (
    !hasExactKeys(metadata, [
      'baseOid',
      'changeRef',
      'checkpointId',
      'childWorkspacePath',
      'createdAt',
      'effectsPerformed',
      'interventionChangeId',
      'kind',
      'metadataDigest',
      'parentChangeId',
      'parentWorkspacePath',
      'state',
      'workspaceId',
    ]) ||
    metadata.kind !== 'intervention-child-worktree.v1' ||
    metadata.state !== 'planned' ||
    metadata.effectsPerformed !== false ||
    metadata.parentChangeId !== parentChangeId ||
    metadata.interventionChangeId !== interventionChangeId ||
    metadata.checkpointId !== checkpointId ||
    metadata.baseOid !== baseOid ||
    metadata.parentWorkspacePath !== parentWorkspacePath ||
    metadata.changeRef !== `refs/heads/work/${interventionChangeId}` ||
    typeof metadata.childWorkspacePath !== 'string' ||
    !path.isAbsolute(metadata.childWorkspacePath) ||
    path.resolve(metadata.childWorkspacePath) !== metadata.childWorkspacePath ||
    !isDigest(metadata.workspaceId) ||
    !isDigest(metadata.metadataDigest) ||
    !isCanonicalIso(metadata.createdAt)
  ) {
    return false;
  }
  const { metadataDigest, ...payload } = metadata;
  if (metadataDigest !== canonicalDigest(payload)) return false;
  return (
    metadata.workspaceId ===
    canonicalDigest({
      kind: 'intervention-child-worktree-identity.v1',
      parentChangeId,
      interventionChangeId,
      checkpointId,
      parentWorkspacePath,
      childWorkspacePath: metadata.childWorkspacePath,
      changeRef: metadata.changeRef,
    })
  );
}

function assertStoredInterventionCheckpoint(
  paths: BootstrapPaths,
  checkpoint: Record<string, unknown>,
): void {
  assertPrivateDirectory(
    paths.checkpoints,
    'WORKFLOW_PARENT_INTERVENTION_STATE_UNSAFE',
  );
  const checkpointId = checkpoint.checkpointId as Sha256Digest;
  const stored = readCanonicalPrivateRecord(
    path.join(
      paths.checkpoints,
      `${checkpointId.slice('sha256:'.length)}.json`,
    ),
    interventionFenceCorrupt,
  );
  if (canonicalJson(stored) !== canonicalJson(checkpoint)) {
    throw interventionFenceCorrupt();
  }
}

function readLocalBinding(filePath: string): BootstrapLocalEngineBinding {
  const value = readCanonicalPrivateRecord(filePath, localBindingCorrupt);
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'activeArtifact',
      'blocker',
      'checkpointId',
      'engineDigest',
      'generation',
      'interventionChangeId',
      'interventionState',
      'kind',
      'parentBranch',
      'parentChangeId',
      'parentWorkspacePath',
      'recordDigest',
      'sessionSchema',
      'txId',
      'updatedAt',
    ]) ||
    value.kind !== 'local-parent-session-metadata.v2' ||
    !verifyRecordDigest(value)
  ) {
    throw localBindingCorrupt();
  }
  const binding = value as unknown as BootstrapLocalEngineBinding;
  if (
    !isNonEmptyTrimmed(binding.parentChangeId) ||
    !isNonEmptyTrimmed(binding.parentWorkspacePath) ||
    !path.isAbsolute(binding.parentWorkspacePath) ||
    path.resolve(binding.parentWorkspacePath) !== binding.parentWorkspacePath ||
    binding.parentBranch !== `refs/heads/work/${binding.parentChangeId}` ||
    !isNonEmptyTrimmed(binding.interventionChangeId) ||
    !isNonEmptyTrimmed(binding.txId) ||
    !isDigest(binding.checkpointId) ||
    !isDigest(binding.engineDigest) ||
    !isRecord(binding.activeArtifact) ||
    !hasExactKeys(binding.activeArtifact, [
      'artifactId',
      'executableDigest',
      'executablePath',
    ]) ||
    !isDigest(binding.activeArtifact.artifactId) ||
    !isDigest(binding.activeArtifact.executableDigest) ||
    typeof binding.activeArtifact.executablePath !== 'string' ||
    !path.isAbsolute(binding.activeArtifact.executablePath) ||
    path.resolve(binding.activeArtifact.executablePath) !==
      binding.activeArtifact.executablePath ||
    !isNonEmptyTrimmed(binding.sessionSchema) ||
    !['active', 'adopted'].includes(binding.interventionState) ||
    !Number.isSafeInteger(binding.generation) ||
    binding.generation < 1 ||
    !isCanonicalIso(binding.updatedAt) ||
    !validLocalBlocker(binding)
  ) {
    throw localBindingCorrupt();
  }
  return binding;
}

function readLocalAdoptionJournal(
  filePath: string,
  txId: string,
): BootstrapLocalAdoptionRecord {
  const value = readCanonicalPrivateRecord(filePath, localJournalCorrupt);
  const recordKeys = [
    'createdAt',
    'effectsPerformed',
    'grantEnvelopeDigest',
    'journal',
    'kind',
    'maintenanceGrantEnvelope',
    'observations',
    'recordDigest',
    'updatedAt',
  ];
  if (!isRecord(value)) throw localJournalCorrupt();
  const schemaVersion = value.kind === 'persisted-engine-adoption.v2' ? 2 : 1;
  if (
    !hasExactKeys(
      value,
      schemaVersion === 2
        ? [...recordKeys, 'artifactRecordDigest']
        : recordKeys,
    ) ||
    !['persisted-engine-adoption.v1', 'persisted-engine-adoption.v2'].includes(
      String(value.kind),
    ) ||
    value.effectsPerformed !== false ||
    !verifyRecordDigest(value) ||
    !isDigest(value.grantEnvelopeDigest) ||
    canonicalDigest(value.maintenanceGrantEnvelope) !==
      value.grantEnvelopeDigest ||
    !Array.isArray(value.observations) ||
    !isCanonicalIso(value.createdAt) ||
    !isCanonicalIso(value.updatedAt) ||
    Date.parse(value.updatedAt) < Date.parse(value.createdAt) ||
    !isRecord(value.journal) ||
    (schemaVersion === 2 && !isDigest(value.artifactRecordDigest))
  ) {
    throw localJournalCorrupt();
  }
  const journal = value.journal as unknown as BootstrapAdoptionJournal;
  const journalKeys = [
    'artifactId',
    'checkpointId',
    'fromEngineDigest',
    'grantId',
    'history',
    'interventionChangeId',
    'journalDigest',
    'kind',
    'parentChangeId',
    'sessionSchema',
    'state',
    'toEngineDigest',
    'txId',
  ];
  if (
    !hasExactKeys(
      value.journal,
      schemaVersion === 2
        ? [...journalKeys, 'workflowBindingDigest', 'workflowStatus']
        : journalKeys,
    ) ||
    journal.kind !== 'engine-adoption-journal.v1' ||
    journal.txId !== txId ||
    !isNonEmptyTrimmed(journal.txId) ||
    !isNonEmptyTrimmed(journal.grantId) ||
    !isNonEmptyTrimmed(journal.parentChangeId) ||
    !isNonEmptyTrimmed(journal.interventionChangeId) ||
    !isNonEmptyTrimmed(journal.sessionSchema) ||
    !isDigest(journal.checkpointId) ||
    !isDigest(journal.fromEngineDigest) ||
    !isDigest(journal.toEngineDigest) ||
    !isDigest(journal.artifactId) ||
    (schemaVersion === 2 &&
      (!isDigest(journal.workflowBindingDigest) ||
        journal.workflowStatus !== 'repair-active')) ||
    !verifyJournalDigest(value.journal) ||
    !validAdoptionHistory(journal.state, journal.history)
  ) {
    throw localJournalCorrupt();
  }
  return {
    schemaVersion,
    journal,
    artifactRecordDigest:
      schemaVersion === 2 ? (value.artifactRecordDigest as Sha256Digest) : null,
  };
}

function assertLocalAdoptionWorkflowBinding(
  paths: BootstrapPaths,
  journal: BootstrapAdoptionJournal,
  artifactRecordDigest: Sha256Digest | null,
): void {
  if (
    artifactRecordDigest === null ||
    !isDigest(journal.workflowBindingDigest) ||
    journal.workflowStatus !== 'repair-active'
  ) {
    throw localJournalCorrupt();
  }
  assertPrivateDirectory(
    paths.sidecarSessions,
    'WORKFLOW_LOCAL_ADOPTION_STATE_UNSAFE',
  );
  const sidecarPath = path.join(
    paths.sidecarSessions,
    `${identityFileName('sidecar-session', journal.parentChangeId)}.json`,
  );
  const value = readCanonicalPrivateRecord(sidecarPath, localJournalCorrupt);
  if (
    !isRecord(value) ||
    value.kind !== 'bootstrap-sidecar-session.v2' ||
    !hasExactKeys(value, [
      'adoption',
      'artifacts',
      'createdAt',
      'history',
      'identity',
      'kind',
      'parentUnblock',
      'promotion',
      'recordDigest',
      'sidecarSessionId',
      'state',
      'updatedAt',
      'workflowBinding',
      'workspace',
    ]) ||
    !verifyRecordDigest(value) ||
    !isRecord(value.identity) ||
    !hasExactKeys(value.identity, [
      'checkpointId',
      'interventionChangeId',
      'parentChangeId',
      'workspaceId',
    ]) ||
    !isRecord(value.workflowBinding) ||
    !hasExactKeys(value.workflowBinding, [
      'baselineOid',
      'changeId',
      'changeRef',
      'checkpointId',
      'kind',
      'parentChangeId',
      'repositoryRoot',
      'status',
      'workflowBindingDigest',
      'workflowId',
      'workflowType',
      'workspaceId',
    ]) ||
    !isRecord(value.workspace) ||
    !hasExactKeys(value.workspace, [
      'changeRef',
      'childWorkspacePath',
      'materializedAt',
      'receiptDigest',
      'state',
    ]) ||
    !Array.isArray(value.artifacts)
  ) {
    throw localJournalCorrupt();
  }
  const identity = value.identity;
  const workflow = value.workflowBinding;
  const workspace = value.workspace;
  if (
    workflow.kind !== 'bootstrap-maintenance-workflow.v1' ||
    workflow.workflowType !== 'bootstrap-maintenance' ||
    !isDigest(workflow.workflowId) ||
    !isDigest(workflow.workflowBindingDigest) ||
    !isDigest(workflow.checkpointId) ||
    !isDigest(workflow.workspaceId) ||
    !isNonEmptyTrimmed(workflow.changeId) ||
    !isNonEmptyTrimmed(workflow.parentChangeId) ||
    typeof workflow.repositoryRoot !== 'string' ||
    !path.isAbsolute(workflow.repositoryRoot) ||
    path.resolve(workflow.repositoryRoot) !== workflow.repositoryRoot ||
    !isNonEmptyTrimmed(workflow.changeRef) ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(String(workflow.baselineOid)) ||
    !['repair-active', 'adopted', 'abandoned'].includes(
      String(workflow.status),
    ) ||
    workflow.status !== value.state ||
    identity.parentChangeId !== journal.parentChangeId ||
    identity.interventionChangeId !== journal.interventionChangeId ||
    identity.checkpointId !== journal.checkpointId ||
    workflow.parentChangeId !== identity.parentChangeId ||
    workflow.changeId !== identity.interventionChangeId ||
    workflow.checkpointId !== identity.checkpointId ||
    workflow.workspaceId !== identity.workspaceId ||
    workflow.repositoryRoot !== workspace.childWorkspacePath ||
    workflow.changeRef !== workspace.changeRef
  ) {
    throw localJournalCorrupt();
  }
  const { workflowBindingDigest, ...workflowPayload } = workflow;
  const expectedWorkflowId = canonicalDigest({
    kind: 'bootstrap-maintenance-workflow-identity.v1',
    changeId: workflow.changeId,
    parentChangeId: workflow.parentChangeId,
    checkpointId: workflow.checkpointId,
    workspaceId: workflow.workspaceId,
  });
  const expectedBindingDigest = canonicalDigest(workflowPayload);
  const activeBindingDigest = canonicalDigest({
    ...workflowPayload,
    status: 'repair-active',
  });
  if (
    workflow.workflowId !== expectedWorkflowId ||
    workflowBindingDigest !== expectedBindingDigest ||
    journal.workflowBindingDigest !== activeBindingDigest ||
    value.sidecarSessionId !==
      canonicalDigest({
        kind: 'bootstrap-sidecar-session-identity.v2',
        ...identity,
        workflowId: workflow.workflowId,
      }) ||
    (journal.state === 'COMMITTED'
      ? !['repair-active', 'adopted'].includes(String(workflow.status))
      : workflow.status !== 'repair-active')
  ) {
    throw localJournalCorrupt();
  }
  const matchingArtifacts = value.artifacts.filter((artifact) => {
    if (
      !isRecord(artifact) ||
      !hasExactKeys(artifact, [
        'artifactId',
        'evidenceDigest',
        'executableDigest',
        'readyAt',
        'sourceDigest',
        'workflowBindingDigest',
        'workflowStatus',
      ])
    ) {
      throw localJournalCorrupt();
    }
    if (
      !isDigest(artifact.artifactId) ||
      !isDigest(artifact.evidenceDigest) ||
      !isDigest(artifact.executableDigest) ||
      !isDigest(artifact.sourceDigest) ||
      !isCanonicalIso(artifact.readyAt) ||
      artifact.workflowBindingDigest !== activeBindingDigest ||
      artifact.workflowStatus !== 'repair-active'
    ) {
      throw localJournalCorrupt();
    }
    return (
      artifact.artifactId === journal.artifactId &&
      artifact.evidenceDigest === artifactRecordDigest
    );
  });
  if (matchingArtifacts.length !== 1) {
    throw localJournalCorrupt();
  }
  assertSidecarAdoptionBinding(value, journal, activeBindingDigest);
}

function assertSidecarAdoptionBinding(
  sidecar: Record<string, unknown>,
  journal: BootstrapAdoptionJournal,
  activeBindingDigest: Sha256Digest,
): void {
  const adoption = sidecar.adoption;
  if (sidecar.state === 'repair-active') {
    if (adoption !== null) throw localJournalCorrupt();
    return;
  }
  if (
    sidecar.state !== 'adopted' ||
    journal.state !== 'COMMITTED' ||
    !isRecord(adoption) ||
    !hasExactKeys(adoption, [
      'adoptedAt',
      'artifactId',
      'journalDigest',
      'txId',
      'workflowBindingDigest',
      'workflowStatus',
    ]) ||
    adoption.txId !== journal.txId ||
    adoption.artifactId !== journal.artifactId ||
    adoption.journalDigest !== journal.journalDigest ||
    !isCanonicalIso(adoption.adoptedAt) ||
    adoption.workflowBindingDigest !== activeBindingDigest ||
    adoption.workflowStatus !== 'repair-active'
  ) {
    throw localJournalCorrupt();
  }
}

function assertLocalBindingJournalIdentity(
  paths: BootstrapPaths,
  binding: BootstrapLocalEngineBinding,
  journal: BootstrapAdoptionJournal,
): void {
  const expectedExecutablePath = path.join(
    paths.localArtifacts,
    journal.artifactId.slice('sha256:'.length),
    'engine',
  );
  if (
    binding.txId !== journal.txId ||
    binding.parentChangeId !== journal.parentChangeId ||
    binding.interventionChangeId !== journal.interventionChangeId ||
    binding.checkpointId !== journal.checkpointId ||
    binding.sessionSchema !== journal.sessionSchema ||
    binding.activeArtifact.artifactId !== journal.artifactId ||
    binding.activeArtifact.executableDigest !== journal.toEngineDigest ||
    binding.activeArtifact.executablePath !== expectedExecutablePath
  ) {
    throw localBindingMismatch();
  }
}

function assertTerminalCommittedBinding(
  binding: BootstrapLocalEngineBinding,
  journal: BootstrapAdoptionJournal,
): void {
  if (
    binding.engineDigest !== journal.toEngineDigest ||
    binding.generation !== 3 ||
    binding.interventionState !== 'adopted' ||
    binding.blocker !== null
  ) {
    throw localBindingMismatch();
  }
}

function assertTerminalRolledBackBinding(
  binding: BootstrapLocalEngineBinding,
  journal: BootstrapAdoptionJournal,
): void {
  if (
    binding.engineDigest !== journal.fromEngineDigest ||
    binding.generation !== 3 ||
    binding.interventionState !== 'active' ||
    !activeLocalBlockerMatches(binding, journal)
  ) {
    throw localBindingMismatch();
  }
}

function assertPermittedIncompleteBinding(
  binding: BootstrapLocalEngineBinding,
  journal: BootstrapAdoptionJournal,
): void {
  const beforeSwitch =
    binding.generation === 1 &&
    binding.engineDigest === journal.fromEngineDigest &&
    binding.interventionState === 'active' &&
    activeLocalBlockerMatches(binding, journal);
  const afterSwitch =
    binding.generation === 2 &&
    binding.engineDigest === journal.toEngineDigest &&
    binding.interventionState === 'active' &&
    activeLocalBlockerMatches(binding, journal);
  const finalizedAheadOfJournal =
    journal.state === 'HEALTHY' &&
    binding.generation === 3 &&
    binding.engineDigest === journal.toEngineDigest &&
    binding.interventionState === 'adopted' &&
    binding.blocker === null;
  const rollbackAheadOfJournal =
    journal.state === 'ROLLBACK_REQUIRED' &&
    binding.generation === 3 &&
    binding.engineDigest === journal.fromEngineDigest &&
    binding.interventionState === 'active' &&
    activeLocalBlockerMatches(binding, journal);
  const allowed =
    journal.state === 'PREPARED'
      ? beforeSwitch
      : journal.state === 'PARENT_CHECKPOINTED'
        ? beforeSwitch || afterSwitch
        : journal.state === 'ENGINE_BINDING_UPDATED' ||
            journal.state === 'NEW_ENGINE_STARTED'
          ? afterSwitch
          : journal.state === 'HEALTHY'
            ? afterSwitch || finalizedAheadOfJournal
            : journal.state === 'ROLLBACK_REQUIRED'
              ? afterSwitch || rollbackAheadOfJournal
              : false;
  if (!allowed) throw localBindingMismatch();
}

function activeLocalBlockerMatches(
  binding: BootstrapLocalEngineBinding,
  journal: BootstrapAdoptionJournal,
): boolean {
  return (
    isRecord(binding.blocker) &&
    hasExactKeys(binding.blocker, ['blockedBy', 'checkpointId', 'kind']) &&
    binding.blocker.kind === 'harness-intervention' &&
    binding.blocker.checkpointId === journal.checkpointId &&
    binding.blocker.blockedBy === journal.interventionChangeId
  );
}

function validLocalBlocker(binding: BootstrapLocalEngineBinding): boolean {
  return (
    binding.blocker === null ||
    (isRecord(binding.blocker) &&
      hasExactKeys(binding.blocker, ['blockedBy', 'checkpointId', 'kind']) &&
      binding.blocker.kind === 'harness-intervention' &&
      binding.blocker.checkpointId === binding.checkpointId &&
      binding.blocker.blockedBy === binding.interventionChangeId)
  );
}

function validAdoptionHistory(state: unknown, history: unknown): boolean {
  if (
    typeof state !== 'string' ||
    !(state in ADOPTION_HISTORIES) ||
    !Array.isArray(history)
  ) {
    return false;
  }
  const expected = ADOPTION_HISTORIES[state as BootstrapAdoptionState];
  if (history.length !== expected.length) return false;
  let previousTime = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < history.length; index += 1) {
    const entry = history[index];
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ['at', 'state']) ||
      entry.state !== expected[index] ||
      !isCanonicalIso(entry.at)
    ) {
      return false;
    }
    const currentTime = Date.parse(entry.at);
    if (currentTime < previousTime) return false;
    previousTime = currentTime;
  }
  return true;
}

function verifyLocalEngineArtifact(
  paths: BootstrapPaths,
  artifact: BootstrapLocalEngineBinding['activeArtifact'],
): void {
  const expectedPath = path.join(
    paths.localArtifacts,
    artifact.artifactId.slice('sha256:'.length),
    'engine',
  );
  if (artifact.executablePath !== expectedPath) throw localBindingMismatch();
  assertPrivateDirectory(
    paths.localArtifacts,
    'WORKFLOW_LOCAL_ADOPTION_ARTIFACT_UNSAFE',
  );
  assertPrivateDirectory(
    path.dirname(expectedPath),
    'WORKFLOW_LOCAL_ADOPTION_ARTIFACT_UNSAFE',
  );
  const stats = fs.lstatSync(expectedPath, { throwIfNoEntry: false });
  if (
    !stats?.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (stats.mode & 0o777) !== PRIVATE_EXECUTABLE_MODE ||
    stats.size < 1 ||
    stats.size > MAX_EXECUTABLE_BYTES ||
    fs.realpathSync(expectedPath) !== expectedPath
  ) {
    throw trustError(
      'WORKFLOW_LOCAL_ADOPTION_ARTIFACT_UNSAFE',
      'Materialized local engine artifact is missing, indirect, or unsafe.',
      12,
    );
  }
  const descriptor = fs.openSync(
    expectedPath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const opened = fs.fstatSync(descriptor);
    const bytes = fs.readFileSync(descriptor);
    if (
      opened.dev !== stats.dev ||
      opened.ino !== stats.ino ||
      opened.size !== stats.size ||
      rawDigest(bytes) !== artifact.executableDigest
    ) {
      throw trustError(
        'WORKFLOW_LOCAL_ADOPTION_ARTIFACT_DIGEST_MISMATCH',
        'Materialized local engine artifact digest changed.',
        13,
      );
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function readSupervisor(
  paths: BootstrapPaths,
): BootstrapControlPlaneSupervisorState {
  const value = readCanonicalPrivateRecord(paths.supervisor);
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'activeArtifact',
      'generation',
      'kind',
      'recordDigest',
      'repositoryId',
      'transition',
      'updatedAt',
    ]) ||
    value.kind !== 'control-plane-supervisor-state.v1' ||
    !verifyRecordDigest(value)
  ) {
    throw supervisorCorrupt();
  }
  const state = value as unknown as BootstrapControlPlaneSupervisorState;
  if (
    !isNonEmptyTrimmed(state.repositoryId) ||
    !Number.isSafeInteger(state.generation) ||
    state.generation < 1 ||
    !isRecord(state.activeArtifact) ||
    !hasExactKeys(state.activeArtifact, [
      'artifactId',
      'closureDigest',
      'executableDigest',
      'executablePath',
    ]) ||
    !isDigest(state.activeArtifact.artifactId) ||
    !isDigest(state.activeArtifact.executableDigest) ||
    !isDigest(state.activeArtifact.closureDigest) ||
    !isCanonicalIso(state.updatedAt) ||
    !validTransition(state.transition)
  ) {
    throw supervisorCorrupt();
  }
  assertConfinedExecutable(paths, state);
  return state;
}

function assertTerminalSelection(
  paths: BootstrapPaths,
  supervisor: BootstrapControlPlaneSupervisorState,
): void {
  const transition = supervisor.transition;
  if (transition === null) {
    try {
      assertInitialBootstrapTerminalSelection(paths, supervisor);
    } catch {
      throw supervisorNotTerminal();
    }
    return;
  }
  assertPrivateDirectory(paths.controlUpdates, 'CONTROL_PLANE_STATE_UNSAFE');
  const recordPath = path.join(
    paths.controlUpdates,
    `${identityFileName('control-update', transition.grantId)}.json`,
  );
  const value = readCanonicalPrivateRecord(recordPath);
  if (isRecord(value) && value.kind === 'persisted-control-plane-update.v2') {
    try {
      assertTerminalSelectionV2(paths, supervisor, value);
    } catch {
      throw supervisorNotTerminal();
    }
    return;
  }
  if (isRecord(value) && value.kind === 'persisted-control-plane-update.v3') {
    try {
      assertTerminalSelectionV3(paths, supervisor, value);
    } catch {
      throw supervisorNotTerminal();
    }
    return;
  }
  // V1 records remain historical audit data, but their signed shape does not
  // carry the immutable candidate and bootstrap lineage required to execute an
  // artifact. Treating a self-digested V1 record as launch authority would
  // permit a discriminator downgrade around the V2 verifier.
  throw supervisorNotTerminal();
}

function assertTerminalSelectionV2(
  paths: BootstrapPaths,
  supervisor: BootstrapControlPlaneSupervisorState,
  record: Record<string, unknown>,
  options: { allowSuccessorInventory?: boolean } = {},
): void {
  if (options.allowSuccessorInventory !== true) {
    assertSingleV2ControlUpdateInventory(paths, supervisor);
  }
  const initialAnchor = assertPromotionHasValidInitialBootstrapAnchor(
    paths,
    supervisor.repositoryId,
  );
  const initialProvenance = initialAnchor.provenance;
  const transition = supervisor.transition;
  if (
    transition === null ||
    !hasExactKeys(record, [
      'afterManifest',
      'beforeManifest',
      'changes',
      'createdAt',
      'effectsPerformed',
      'envelope',
      'grantState',
      'kind',
      'observations',
      'recordDigest',
      'transaction',
      'updatedAt',
    ]) ||
    record.kind !== 'persisted-control-plane-update.v2' ||
    record.grantState !== 'consumed' ||
    record.effectsPerformed !== false ||
    !verifyRecordDigest(record) ||
    !isCanonicalIso(record.createdAt) ||
    !isCanonicalIso(record.updatedAt) ||
    Date.parse(record.updatedAt) < Date.parse(record.createdAt) ||
    !isRecord(record.transaction) ||
    !isRecord(record.envelope) ||
    !isRecord(record.beforeManifest) ||
    !isRecord(record.afterManifest) ||
    !Array.isArray(record.changes) ||
    !Array.isArray(record.observations)
  ) {
    throw supervisorNotTerminal();
  }

  const transaction = record.transaction;
  if (
    !hasExactKeys(transaction, [
      'afterClosureDigest',
      'beforeClosureDigest',
      'candidateDigest',
      'grantId',
      'history',
      'journalDigest',
      'kind',
      'recoveryBundleDigest',
      'state',
      'txId',
      'updaterVersion',
    ]) ||
    transaction.kind !== 'minimal-control-plane-updater.v1' ||
    transaction.updaterVersion !== 2 ||
    transaction.grantId !== transition.grantId ||
    transaction.txId !== transition.txId ||
    !isNonEmptyTrimmed(transaction.grantId) ||
    !isNonEmptyTrimmed(transaction.txId) ||
    !isDigest(transaction.candidateDigest) ||
    !isDigest(transaction.beforeClosureDigest) ||
    !isDigest(transaction.afterClosureDigest) ||
    !isDigest(transaction.recoveryBundleDigest) ||
    !verifyJournalDigest(transaction) ||
    !validTerminalHistory(transaction.state, transaction.history) ||
    !validTerminalObservationsV2(
      transaction.history,
      record.observations,
      record.createdAt,
      record.updatedAt,
    ) ||
    transaction.beforeClosureDigest !==
      initialAnchor.activeArtifact.closureDigest
  ) {
    throw supervisorNotTerminal();
  }

  const beforeManifest = record.beforeManifest;
  const afterManifest = record.afterManifest;
  const changes = record.changes;
  if (
    !validProtectedCapabilityManifestV2(beforeManifest) ||
    !validProtectedCapabilityManifestV2(afterManifest) ||
    !validExactChangesV2(changes) ||
    beforeManifest.manifestDigest !== transaction.beforeClosureDigest ||
    afterManifest.manifestDigest !== transaction.afterClosureDigest ||
    (beforeManifest.manifestDigest !== afterManifest.manifestDigest &&
      !changes.some((change) => change.path === beforeManifest.manifestPath))
  ) {
    throw supervisorNotTerminal();
  }

  const envelope = record.envelope;
  if (
    !hasExactKeys(envelope, ['payload', 'signature']) ||
    !isRecord(envelope.payload) ||
    !validBoundedSignature(envelope.signature)
  ) {
    throw supervisorNotTerminal();
  }
  const payload = envelope.payload;
  if (
    !validControlPlaneGrantPayloadV2(payload) ||
    payload.grantId !== transition.grantId ||
    payload.repositoryId !== supervisor.repositoryId ||
    payload.candidateDigest !== transaction.candidateDigest ||
    payload.beforeClosureDigest !== transaction.beforeClosureDigest ||
    payload.afterClosureDigest !== transaction.afterClosureDigest ||
    payload.recoveryBundle.bundleDigest !== transaction.recoveryBundleDigest ||
    payload.updaterVersion !== transaction.updaterVersion ||
    canonicalJson(payload.exactChanges) !== canonicalJson(changes) ||
    Date.parse(payload.issuedAt) > Date.parse(record.createdAt)
  ) {
    throw supervisorNotTerminal();
  }

  assertPrivateDirectory(paths.bundles, 'CONTROL_PLANE_STATE_UNSAFE');
  const bundlePath = path.join(
    paths.bundles,
    `${identityFileName('control-plane-promotion', transition.grantId)}.json`,
  );
  const bundle = readCanonicalPrivateRecord(
    bundlePath,
    supervisorNotTerminal,
    MAX_PROMOTION_BUNDLE_BYTES,
  );
  if (
    !isRecord(bundle) ||
    !validPromotionBundleV2(bundle, payload, beforeManifest, afterManifest)
  ) {
    throw supervisorNotTerminal();
  }
  const material = bundle.material;
  const expectedOldCommit = assertV2PromotionHumanSignatures(
    paths,
    initialProvenance,
    material,
    bundle.independentReviewAttestation,
    payload,
    envelope.signature,
    beforeManifest,
  );
  if (expectedOldCommit !== initialProvenance.headOid) {
    throw supervisorNotTerminal();
  }

  const impact = affectedCapabilitiesForV2(
    beforeManifest,
    afterManifest,
    changes,
  );
  if (
    impact === null ||
    canonicalJson(impact) !== canonicalJson(payload.affectedCapabilities) ||
    canonicalJson(payload.affectedCapabilities) !==
      canonicalJson(material.affectedCapabilities)
  ) {
    throw supervisorNotTerminal();
  }

  const candidateArtifact = material.candidateArtifact;
  const restartArtifact = material.recoveryBundle.restartArtifact;
  assertMaterializedPromotionArtifact(
    paths,
    candidateArtifact,
    material.candidateExecutableBase64,
  );
  assertMaterializedPromotionArtifact(
    paths,
    restartArtifact,
    material.recoveryBundle.restartExecutableBase64,
  );

  const candidateSelected =
    transition.phase === 'candidate-selected' &&
    transaction.state === 'FINALIZED' &&
    supervisor.generation === 2 &&
    supervisor.activeArtifact.artifactId === candidateArtifact.artifactId &&
    supervisor.activeArtifact.executableDigest ===
      candidateArtifact.executableDigest &&
    supervisor.activeArtifact.closureDigest === transaction.afterClosureDigest;
  const rollbackRestored =
    transition.phase === 'rollback-restored' &&
    transaction.state === 'ROLLED_BACK' &&
    supervisor.generation === 3 &&
    supervisor.activeArtifact.artifactId === restartArtifact.artifactId &&
    supervisor.activeArtifact.executableDigest ===
      restartArtifact.executableDigest &&
    supervisor.activeArtifact.closureDigest === transaction.beforeClosureDigest;
  if (!candidateSelected && !rollbackRestored) {
    throw supervisorNotTerminal();
  }
  if (options.allowSuccessorInventory !== true) {
    assertSingleV2ControlUpdateInventory(paths, supervisor);
  }
}

function assertTerminalSelectionV3(
  paths: BootstrapPaths,
  supervisor: BootstrapControlPlaneSupervisorState,
  currentRecord: Record<string, unknown>,
): void {
  const history = readBootstrapSupervisorHistory(paths);
  const leaf = history.leaf;
  const transition = supervisor.transition;
  if (
    transition === null ||
    history.anchor.repositoryId !== supervisor.repositoryId ||
    leaf.repositoryId !== supervisor.repositoryId ||
    leaf.generation !== supervisor.generation ||
    leaf.supervisorRecordDigest !== supervisor.recordDigest ||
    canonicalJson(leaf.activeArtifact) !==
      canonicalJson({
        artifactId: supervisor.activeArtifact.artifactId,
        executableDigest: supervisor.activeArtifact.executableDigest,
        closureDigest: supervisor.activeArtifact.closureDigest,
      }) ||
    leaf.grantId !== transition.grantId ||
    leaf.txId !== transition.txId ||
    transition.phase !==
      (leaf.terminalState === 'FINALIZED'
        ? 'candidate-selected'
        : 'rollback-restored') ||
    leaf.updateRecordDigest !== currentRecord.recordDigest
  ) {
    throw supervisorNotTerminal();
  }
  const initialProvenance = assertBootstrapHistoryAnchor(
    paths,
    history.anchor,
    supervisor,
  );
  const expectedGrantIds = new Set<string>();
  if (history.anchor.authority.kind === 'legacy-v2-terminal-anchor.v1') {
    expectedGrantIds.add(history.anchor.authority.grantId);
  }
  let index = 1;
  while (index < history.records.length) {
    const predecessor = history.records[index - 1]!;
    if (
      predecessor.kind !== 'control-plane-supervisor-history-anchor.v1' &&
      predecessor.kind !== 'control-plane-supervisor-history-terminal.v1'
    ) {
      throw supervisorNotTerminal();
    }
    const candidateTransition = history.records[index];
    if (
      candidateTransition?.kind !==
        'control-plane-supervisor-history-transition.v1' ||
      candidateTransition.phase !== 'candidate-selected'
    ) {
      throw supervisorNotTerminal();
    }
    const possibleRollback = history.records[index + 1];
    const rollbackTransition =
      possibleRollback?.kind ===
        'control-plane-supervisor-history-transition.v1' &&
      possibleRollback.phase === 'rollback-restored'
        ? possibleRollback
        : null;
    const terminal = history.records[index + (rollbackTransition ? 2 : 1)];
    if (terminal?.kind !== 'control-plane-supervisor-history-terminal.v1') {
      throw supervisorNotTerminal();
    }
    const record =
      terminal.recordDigest === leaf.recordDigest
        ? currentRecord
        : readCanonicalPrivateRecord(
            path.join(
              paths.controlUpdates,
              `${identityFileName('control-update', terminal.grantId)}.json`,
            ),
          );
    if (!isRecord(record)) throw supervisorNotTerminal();
    assertV3HistoryUpdate(
      paths,
      initialProvenance,
      history.anchor,
      predecessor,
      candidateTransition,
      rollbackTransition,
      terminal,
      record,
    );
    expectedGrantIds.add(terminal.grantId);
    index += rollbackTransition ? 3 : 2;
  }
  assertExactControlPlaneAuthorityInventory(paths, expectedGrantIds);
}

function assertV3HistoryUpdate(
  paths: BootstrapPaths,
  initialProvenance: InitialSupervisorProvenance,
  anchor: BootstrapSupervisorHistoryAnchor,
  predecessor:
    BootstrapSupervisorHistoryAnchor | BootstrapSupervisorHistoryTerminal,
  candidateTransition: BootstrapSupervisorHistoryTransition,
  rollbackTransition: BootstrapSupervisorHistoryTransition | null,
  terminal: BootstrapSupervisorHistoryTerminal,
  record: Record<string, unknown>,
): void {
  if (
    !hasExactKeys(record, [
      'afterManifest',
      'beforeManifest',
      'changes',
      'createdAt',
      'effectsPerformed',
      'envelope',
      'grantState',
      'kind',
      'observations',
      'recordDigest',
      'transaction',
      'updatedAt',
    ]) ||
    record.kind !== 'persisted-control-plane-update.v3' ||
    record.grantState !== 'consumed' ||
    record.effectsPerformed !== false ||
    !verifyRecordDigest(record) ||
    !isCanonicalIso(record.createdAt) ||
    !isCanonicalIso(record.updatedAt) ||
    Date.parse(record.updatedAt) < Date.parse(record.createdAt) ||
    !isRecord(record.transaction) ||
    !isRecord(record.envelope) ||
    !isRecord(record.beforeManifest) ||
    !isRecord(record.afterManifest) ||
    !Array.isArray(record.changes) ||
    !Array.isArray(record.observations)
  ) {
    throw supervisorNotTerminal();
  }
  const transaction = record.transaction;
  if (
    !hasExactKeys(transaction, [
      'afterClosureDigest',
      'beforeClosureDigest',
      'candidateDigest',
      'grantId',
      'history',
      'journalDigest',
      'kind',
      'recoveryBundleDigest',
      'state',
      'txId',
      'updaterVersion',
    ]) ||
    transaction.kind !== 'minimal-control-plane-updater.v1' ||
    transaction.updaterVersion !== 3 ||
    transaction.grantId !== terminal.grantId ||
    transaction.txId !== terminal.txId ||
    !isNonEmptyTrimmed(transaction.grantId) ||
    !isNonEmptyTrimmed(transaction.txId) ||
    !isDigest(transaction.candidateDigest) ||
    !isDigest(transaction.beforeClosureDigest) ||
    !isDigest(transaction.afterClosureDigest) ||
    !isDigest(transaction.recoveryBundleDigest) ||
    !verifyJournalDigest(transaction) ||
    !validTerminalHistory(transaction.state, transaction.history) ||
    !validTerminalObservationsV2(
      transaction.history,
      record.observations,
      record.createdAt,
      record.updatedAt,
    ) ||
    transaction.state !== terminal.terminalState ||
    transaction.beforeClosureDigest !== predecessor.activeArtifact.closureDigest
  ) {
    throw supervisorNotTerminal();
  }
  const beforeManifest = record.beforeManifest;
  const afterManifest = record.afterManifest;
  const changes = record.changes;
  if (
    !validProtectedCapabilityManifestV2(beforeManifest) ||
    !validProtectedCapabilityManifestV2(afterManifest) ||
    !validExactChangesV2(changes) ||
    beforeManifest.manifestDigest !== transaction.beforeClosureDigest ||
    afterManifest.manifestDigest !== transaction.afterClosureDigest ||
    (beforeManifest.manifestDigest !== afterManifest.manifestDigest &&
      !changes.some((change) => change.path === beforeManifest.manifestPath))
  ) {
    throw supervisorNotTerminal();
  }
  const envelope = record.envelope;
  if (
    !hasExactKeys(envelope, ['payload', 'signature']) ||
    !isRecord(envelope.payload) ||
    !validBoundedSignature(envelope.signature)
  ) {
    throw supervisorNotTerminal();
  }
  const payload = assertedGrantPayloadV3(envelope.payload);
  if (
    payload.grantId !== terminal.grantId ||
    payload.repositoryId !== terminal.repositoryId ||
    payload.candidateDigest !== transaction.candidateDigest ||
    payload.beforeClosureDigest !== transaction.beforeClosureDigest ||
    payload.afterClosureDigest !== transaction.afterClosureDigest ||
    payload.recoveryBundle.bundleDigest !== transaction.recoveryBundleDigest ||
    canonicalJson(payload.exactChanges) !== canonicalJson(changes) ||
    Date.parse(payload.issuedAt) > Date.parse(record.createdAt)
  ) {
    throw supervisorNotTerminal();
  }
  const bundle = readCanonicalPrivateRecord(
    path.join(
      paths.bundles,
      `${identityFileName('control-plane-promotion', terminal.grantId)}.json`,
    ),
    supervisorNotTerminal,
    MAX_PROMOTION_BUNDLE_BYTES,
  );
  if (
    !isRecord(bundle) ||
    !validPromotionBundleV3(bundle, payload, beforeManifest, afterManifest)
  ) {
    throw supervisorNotTerminal();
  }
  const material = bundle.material;
  const lineage = bundle.lineage;
  const candidate = assertV3PromotionHumanSignatures(
    paths,
    initialProvenance,
    material,
    lineage,
    bundle.independentReviewAttestation,
    payload,
    envelope.signature,
    beforeManifest,
  );
  const impact = affectedCapabilitiesForV2(
    beforeManifest,
    afterManifest,
    changes,
  );
  if (
    impact === null ||
    canonicalJson(impact) !== canonicalJson(payload.affectedCapabilities) ||
    canonicalJson(payload.affectedCapabilities) !==
      canonicalJson(material.affectedCapabilities)
  ) {
    throw supervisorNotTerminal();
  }
  const candidateArtifact = material.candidateArtifact;
  const restartArtifact = material.recoveryBundle.restartArtifact;
  assertMaterializedPromotionArtifact(
    paths,
    candidateArtifact,
    material.candidateExecutableBase64,
  );
  assertMaterializedPromotionArtifact(
    paths,
    restartArtifact,
    material.recoveryBundle.restartExecutableBase64,
  );
  if (
    lineage.historyAnchorDigest !== anchor.recordDigest ||
    lineage.previousTerminalRecordDigest !== predecessor.recordDigest ||
    lineage.previousSupervisorRecordDigest !==
      predecessor.supervisorRecordDigest ||
    lineage.previousGeneration !== predecessor.generation ||
    lineage.candidateGeneration !== predecessor.generation + 1 ||
    lineage.rollbackGeneration !== predecessor.generation + 2 ||
    lineage.previousActiveTrustCommit !== predecessor.activeTrustCommit ||
    lineage.candidateTrustCommit !== candidate.candidateCommit ||
    candidateTransition.grantId !== payload.grantId ||
    candidateTransition.txId !== transaction.txId ||
    candidateTransition.grantEnvelopeDigest !== canonicalDigest(envelope) ||
    candidateTransition.promotionBundleDigest !== bundle.bundleDigest ||
    candidateTransition.promotionLineageDigest !== lineage.lineageDigest ||
    candidateTransition.sourceJournalDigest !==
      minimalUpdaterJournalDigestAt(transaction, 'RECOVERY_VERIFIED') ||
    candidateTransition.toGeneration !== lineage.candidateGeneration ||
    candidateTransition.activeTrustCommit !== lineage.candidateTrustCommit ||
    canonicalJson(candidateTransition.activeArtifact) !==
      canonicalJson({
        artifactId: candidateArtifact.artifactId,
        executableDigest: candidateArtifact.executableDigest,
        closureDigest: transaction.afterClosureDigest,
      }) ||
    terminal.updateRecordDigest !== record.recordDigest ||
    terminal.transactionJournalDigest !== transaction.journalDigest ||
    terminal.grantEnvelopeDigest !== canonicalDigest(envelope) ||
    terminal.promotionBundleDigest !== bundle.bundleDigest
  ) {
    throw supervisorNotTerminal();
  }
  if (transaction.state === 'FINALIZED') {
    if (
      rollbackTransition !== null ||
      terminal.previousRecordDigest !== candidateTransition.recordDigest ||
      terminal.generation !== lineage.candidateGeneration
    ) {
      throw supervisorNotTerminal();
    }
  } else if (
    rollbackTransition === null ||
    rollbackTransition.grantId !== payload.grantId ||
    rollbackTransition.txId !== transaction.txId ||
    rollbackTransition.sourceJournalDigest !==
      minimalUpdaterJournalDigestAt(transaction, 'ROLLBACK_REQUIRED') ||
    rollbackTransition.toGeneration !== lineage.rollbackGeneration ||
    rollbackTransition.activeTrustCommit !==
      lineage.previousActiveTrustCommit ||
    canonicalJson(rollbackTransition.activeArtifact) !==
      canonicalJson({
        artifactId: restartArtifact.artifactId,
        executableDigest: restartArtifact.executableDigest,
        closureDigest: transaction.beforeClosureDigest,
      }) ||
    terminal.previousRecordDigest !== rollbackTransition.recordDigest ||
    terminal.generation !== lineage.rollbackGeneration
  ) {
    throw supervisorNotTerminal();
  }
}

function minimalUpdaterJournalDigestAt(
  transaction: Record<string, unknown>,
  state: 'RECOVERY_VERIFIED' | 'ROLLBACK_REQUIRED',
): Sha256Digest {
  if (!Array.isArray(transaction.history)) throw supervisorNotTerminal();
  const index = transaction.history.findIndex(
    (entry) => isRecord(entry) && entry.state === state,
  );
  if (index < 0) throw supervisorNotTerminal();
  const { journalDigest: _journalDigest, ...payload } = transaction;
  return canonicalDigest({
    ...payload,
    state,
    history: transaction.history.slice(0, index + 1),
  });
}

function assertExactControlPlaneAuthorityInventory(
  paths: BootstrapPaths,
  expectedGrantIds: ReadonlySet<string>,
): void {
  const expectedUpdates = [...expectedGrantIds]
    .map((grantId) => `${identityFileName('control-update', grantId)}.json`)
    .sort();
  const expectedBundles = [...expectedGrantIds]
    .map(
      (grantId) =>
        `${identityFileName('control-plane-promotion', grantId)}.json`,
    )
    .sort();
  for (const [directory, expected] of [
    [paths.controlUpdates, expectedUpdates],
    [paths.bundles, expectedBundles],
  ] as const) {
    assertPrivateDirectory(directory, 'CONTROL_PLANE_STATE_UNSAFE');
    const entries = fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    if (
      canonicalJson(entries.map(({ name }) => name)) !==
        canonicalJson(expected) ||
      entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())
    ) {
      throw supervisorNotTerminal();
    }
  }
}

function readBootstrapSupervisorHistory(
  paths: BootstrapPaths,
): BootstrapSupervisorHistory {
  assertPrivateDirectory(paths.supervisorHistory, 'CONTROL_PLANE_STATE_UNSAFE');
  const records = fs
    .readdirSync(paths.supervisorHistory, { withFileTypes: true })
    .map((entry) => {
      if (
        !CONTROL_PLANE_HISTORY_RECORD_FILE.test(entry.name) ||
        !entry.isFile() ||
        entry.isSymbolicLink()
      ) {
        throw supervisorNotTerminal();
      }
      const record = parseBootstrapSupervisorHistoryRecord(
        readCanonicalPrivateRecord(
          path.join(paths.supervisorHistory, entry.name),
          supervisorNotTerminal,
        ),
      );
      if (
        entry.name !== `${record.recordDigest.slice('sha256:'.length)}.json`
      ) {
        throw supervisorNotTerminal();
      }
      return record;
    });
  if (records.length === 0) throw supervisorNotTerminal();
  const digests = new Set<string>();
  const childCounts = new Map<string, number>();
  for (const record of records) {
    if (digests.has(record.recordDigest)) throw supervisorNotTerminal();
    digests.add(record.recordDigest);
    if (record.previousRecordDigest !== null) {
      childCounts.set(
        record.previousRecordDigest,
        (childCounts.get(record.previousRecordDigest) ?? 0) + 1,
      );
    }
  }
  if ([...childCounts.values()].some((count) => count !== 1)) {
    throw supervisorNotTerminal();
  }
  const ordered = records.sort((left, right) => left.sequence - right.sequence);
  const anchor = ordered[0];
  if (
    anchor?.kind !== 'control-plane-supervisor-history-anchor.v1' ||
    anchor.sequence !== 0
  ) {
    throw supervisorNotTerminal();
  }
  for (let index = 0; index < ordered.length; index += 1) {
    const current = ordered[index]!;
    if (
      current.sequence !== index ||
      current.repositoryId !== anchor.repositoryId
    ) {
      throw supervisorNotTerminal();
    }
    if (index === 0) continue;
    const previous = ordered[index - 1]!;
    if (
      current.previousRecordDigest !== previous.recordDigest ||
      Date.parse(current.recordedAt) < Date.parse(previous.recordedAt)
    ) {
      throw supervisorNotTerminal();
    }
    if (current.kind === 'control-plane-supervisor-history-transition.v1') {
      assertBootstrapHistoryTransition(previous, current);
      if (current.phase === 'rollback-restored') {
        const restored = ordered[index - 2];
        if (
          restored === undefined ||
          canonicalJson(current.activeArtifact) !==
            canonicalJson(bootstrapHistoryArtifact(restored)) ||
          current.activeTrustCommit !== bootstrapHistoryTrustCommit(restored)
        ) {
          throw supervisorNotTerminal();
        }
      }
    } else if (
      current.kind === 'control-plane-supervisor-history-terminal.v1'
    ) {
      assertBootstrapHistoryTerminal(previous, current);
    } else {
      throw supervisorNotTerminal();
    }
  }
  const leaf = ordered.at(-1);
  if (leaf?.kind !== 'control-plane-supervisor-history-terminal.v1') {
    throw supervisorNotTerminal();
  }
  return { records: ordered, anchor, leaf };
}

function parseBootstrapSupervisorHistoryRecord(
  value: unknown,
): BootstrapSupervisorHistoryRecord {
  if (!isRecord(value) || !verifyRecordDigest(value)) {
    throw supervisorNotTerminal();
  }
  if (value.kind === 'control-plane-supervisor-history-anchor.v1') {
    if (
      !hasExactKeys(value, [
        'activeArtifact',
        'activeTrustCommit',
        'authority',
        'generation',
        'kind',
        'previousRecordDigest',
        'recordDigest',
        'recordedAt',
        'repositoryId',
        'sequence',
        'supervisorRecordDigest',
      ]) ||
      value.sequence !== 0 ||
      value.previousRecordDigest !== null ||
      !positiveSafeInteger(value.generation) ||
      !isNonEmptyTrimmed(value.repositoryId) ||
      !isDigest(value.supervisorRecordDigest) ||
      !isGitObjectId(value.activeTrustCommit) ||
      !isCanonicalIso(value.recordedAt) ||
      !validBootstrapHistoryArtifact(value.activeArtifact)
    ) {
      throw supervisorNotTerminal();
    }
    const authority = parseBootstrapHistoryAnchorAuthority(value.authority);
    return {
      ...(value as unknown as BootstrapSupervisorHistoryAnchor),
      authority,
    };
  }
  if (value.kind === 'control-plane-supervisor-history-transition.v1') {
    if (
      !hasExactKeys(value, [
        'activeArtifact',
        'activeTrustCommit',
        'fromGeneration',
        'fromSupervisorRecordDigest',
        'grantEnvelopeDigest',
        'grantId',
        'kind',
        'phase',
        'previousRecordDigest',
        'promotionBundleDigest',
        'promotionLineageDigest',
        'recordDigest',
        'recordedAt',
        'repositoryId',
        'sequence',
        'sourceJournalDigest',
        'sourceTransactionState',
        'toGeneration',
        'toSupervisorRecordDigest',
        'txId',
      ]) ||
      !positiveSafeInteger(value.sequence) ||
      !positiveSafeInteger(value.fromGeneration) ||
      !positiveSafeInteger(value.toGeneration) ||
      value.toGeneration !== Number(value.fromGeneration) + 1 ||
      (value.phase !== 'candidate-selected' &&
        value.phase !== 'rollback-restored') ||
      (value.sourceTransactionState !== 'RECOVERY_VERIFIED' &&
        value.sourceTransactionState !== 'ROLLBACK_REQUIRED') ||
      !isNonEmptyTrimmed(value.repositoryId) ||
      !isNonEmptyTrimmed(value.grantId) ||
      !isNonEmptyTrimmed(value.txId) ||
      !isDigest(value.previousRecordDigest) ||
      !isDigest(value.fromSupervisorRecordDigest) ||
      !isDigest(value.toSupervisorRecordDigest) ||
      !isDigest(value.grantEnvelopeDigest) ||
      !isDigest(value.promotionBundleDigest) ||
      !isDigest(value.promotionLineageDigest) ||
      !isDigest(value.sourceJournalDigest) ||
      !isGitObjectId(value.activeTrustCommit) ||
      !isCanonicalIso(value.recordedAt) ||
      !validBootstrapHistoryArtifact(value.activeArtifact)
    ) {
      throw supervisorNotTerminal();
    }
    return value as unknown as BootstrapSupervisorHistoryTransition;
  }
  if (value.kind === 'control-plane-supervisor-history-terminal.v1') {
    if (
      !hasExactKeys(value, [
        'activeArtifact',
        'activeTrustCommit',
        'generation',
        'grantEnvelopeDigest',
        'grantId',
        'kind',
        'previousRecordDigest',
        'promotionBundleDigest',
        'recordDigest',
        'recordedAt',
        'repositoryId',
        'sequence',
        'supervisorRecordDigest',
        'terminalState',
        'transactionJournalDigest',
        'txId',
        'updateRecordDigest',
      ]) ||
      !positiveSafeInteger(value.sequence) ||
      !positiveSafeInteger(value.generation) ||
      (value.terminalState !== 'FINALIZED' &&
        value.terminalState !== 'ROLLED_BACK') ||
      !isNonEmptyTrimmed(value.repositoryId) ||
      !isNonEmptyTrimmed(value.grantId) ||
      !isNonEmptyTrimmed(value.txId) ||
      !isDigest(value.previousRecordDigest) ||
      !isDigest(value.supervisorRecordDigest) ||
      !isDigest(value.updateRecordDigest) ||
      !isDigest(value.transactionJournalDigest) ||
      !isDigest(value.grantEnvelopeDigest) ||
      !isDigest(value.promotionBundleDigest) ||
      !isGitObjectId(value.activeTrustCommit) ||
      !isCanonicalIso(value.recordedAt) ||
      !validBootstrapHistoryArtifact(value.activeArtifact)
    ) {
      throw supervisorNotTerminal();
    }
    return value as unknown as BootstrapSupervisorHistoryTerminal;
  }
  throw supervisorNotTerminal();
}

function parseBootstrapHistoryAnchorAuthority(
  value: unknown,
): BootstrapSupervisorHistoryAnchorAuthority {
  if (!isRecord(value)) throw supervisorNotTerminal();
  if (value.kind === 'initial-bootstrap-anchor.v1') {
    if (
      !hasExactKeys(value, ['initialBootstrapPublishedDigest', 'kind']) ||
      !isDigest(value.initialBootstrapPublishedDigest)
    ) {
      throw supervisorNotTerminal();
    }
    return value as unknown as BootstrapSupervisorHistoryAnchorAuthority;
  }
  if (
    value.kind !== 'legacy-v2-terminal-anchor.v1' ||
    !hasExactKeys(value, [
      'grantEnvelopeDigest',
      'grantId',
      'initialBootstrapPublishedDigest',
      'kind',
      'promotionBundleDigest',
      'terminalState',
      'transactionJournalDigest',
      'txId',
      'updateRecordDigest',
    ]) ||
    (value.terminalState !== 'FINALIZED' &&
      value.terminalState !== 'ROLLED_BACK') ||
    !isNonEmptyTrimmed(value.grantId) ||
    !isNonEmptyTrimmed(value.txId) ||
    !isDigest(value.initialBootstrapPublishedDigest) ||
    !isDigest(value.updateRecordDigest) ||
    !isDigest(value.transactionJournalDigest) ||
    !isDigest(value.grantEnvelopeDigest) ||
    !isDigest(value.promotionBundleDigest)
  ) {
    throw supervisorNotTerminal();
  }
  return value as unknown as BootstrapSupervisorHistoryAnchorAuthority;
}

function validBootstrapHistoryArtifact(
  value: unknown,
): value is BootstrapSupervisorHistoryArtifact {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['artifactId', 'closureDigest', 'executableDigest']) &&
    isDigest(value.artifactId) &&
    isDigest(value.executableDigest) &&
    isDigest(value.closureDigest)
  );
}

function assertBootstrapHistoryTransition(
  previous: BootstrapSupervisorHistoryRecord,
  current: BootstrapSupervisorHistoryTransition,
): void {
  if (
    current.fromGeneration !== bootstrapHistoryGeneration(previous) ||
    current.fromSupervisorRecordDigest !==
      bootstrapHistorySupervisorDigest(previous)
  ) {
    throw supervisorNotTerminal();
  }
  if (current.phase === 'candidate-selected') {
    if (
      (previous.kind !== 'control-plane-supervisor-history-anchor.v1' &&
        previous.kind !== 'control-plane-supervisor-history-terminal.v1') ||
      current.sourceTransactionState !== 'RECOVERY_VERIFIED'
    ) {
      throw supervisorNotTerminal();
    }
    return;
  }
  if (
    previous.kind !== 'control-plane-supervisor-history-transition.v1' ||
    previous.phase !== 'candidate-selected' ||
    current.sourceTransactionState !== 'ROLLBACK_REQUIRED' ||
    current.grantId !== previous.grantId ||
    current.txId !== previous.txId ||
    current.grantEnvelopeDigest !== previous.grantEnvelopeDigest ||
    current.promotionBundleDigest !== previous.promotionBundleDigest ||
    current.promotionLineageDigest !== previous.promotionLineageDigest
  ) {
    throw supervisorNotTerminal();
  }
}

function assertBootstrapHistoryTerminal(
  previous: BootstrapSupervisorHistoryRecord,
  current: BootstrapSupervisorHistoryTerminal,
): void {
  if (
    previous.kind !== 'control-plane-supervisor-history-transition.v1' ||
    current.generation !== previous.toGeneration ||
    current.supervisorRecordDigest !== previous.toSupervisorRecordDigest ||
    canonicalJson(current.activeArtifact) !==
      canonicalJson(previous.activeArtifact) ||
    current.activeTrustCommit !== previous.activeTrustCommit ||
    current.grantId !== previous.grantId ||
    current.txId !== previous.txId ||
    current.grantEnvelopeDigest !== previous.grantEnvelopeDigest ||
    current.promotionBundleDigest !== previous.promotionBundleDigest ||
    (current.terminalState === 'FINALIZED' &&
      previous.phase !== 'candidate-selected') ||
    (current.terminalState === 'ROLLED_BACK' &&
      previous.phase !== 'rollback-restored')
  ) {
    throw supervisorNotTerminal();
  }
}

function bootstrapHistoryGeneration(
  record: BootstrapSupervisorHistoryRecord,
): number {
  return record.kind === 'control-plane-supervisor-history-transition.v1'
    ? record.toGeneration
    : record.generation;
}

function bootstrapHistorySupervisorDigest(
  record: BootstrapSupervisorHistoryRecord,
): Sha256Digest {
  return record.kind === 'control-plane-supervisor-history-transition.v1'
    ? record.toSupervisorRecordDigest
    : record.supervisorRecordDigest;
}

function bootstrapHistoryArtifact(
  record: BootstrapSupervisorHistoryRecord,
): BootstrapSupervisorHistoryArtifact {
  return record.activeArtifact;
}

function bootstrapHistoryTrustCommit(
  record: BootstrapSupervisorHistoryRecord,
): string {
  return record.activeTrustCommit;
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function isGitObjectId(value: unknown): value is string {
  return (
    typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)
  );
}

function assertBootstrapHistoryAnchor(
  paths: BootstrapPaths,
  anchor: BootstrapSupervisorHistoryAnchor,
  currentSupervisor: BootstrapControlPlaneSupervisorState,
): InitialSupervisorProvenance {
  const initial = assertPromotionHasValidInitialBootstrapAnchor(
    paths,
    anchor.repositoryId,
  );
  const published = readInitialBootstrapJournalRecord(
    path.join(
      paths.initialBootstrapJournal,
      INITIAL_BOOTSTRAP_PHASE_FILES.SUPERVISOR_PUBLISHED,
    ),
  );
  if (
    published.provenance.repositoryId !== anchor.repositoryId ||
    published.provenance.headOid !== initial.provenance.headOid
  ) {
    throw supervisorNotTerminal();
  }
  if (anchor.authority.kind === 'initial-bootstrap-anchor.v1') {
    if (
      anchor.generation !== 1 ||
      anchor.supervisorRecordDigest !== published.supervisorRecordDigest ||
      canonicalJson(anchor.activeArtifact) !==
        canonicalJson({
          artifactId: published.activeArtifact.artifactId,
          executableDigest: published.activeArtifact.executableDigest,
          closureDigest: published.activeArtifact.closureDigest,
        }) ||
      anchor.activeTrustCommit !== published.provenance.headOid ||
      anchor.recordedAt !== published.initializedAt ||
      anchor.authority.initialBootstrapPublishedDigest !==
        published.recordDigest
    ) {
      throw supervisorNotTerminal();
    }
    return published.provenance;
  }

  const authority = anchor.authority;
  const recordPath = path.join(
    paths.controlUpdates,
    `${identityFileName('control-update', authority.grantId)}.json`,
  );
  const record = readCanonicalPrivateRecord(recordPath);
  const syntheticSupervisor: BootstrapControlPlaneSupervisorState = {
    kind: 'control-plane-supervisor-state.v1',
    repositoryId: anchor.repositoryId,
    activeArtifact: {
      ...anchor.activeArtifact,
      executablePath: currentSupervisor.activeArtifact.executablePath,
    },
    generation: anchor.generation,
    transition: {
      grantId: authority.grantId,
      txId: authority.txId,
      phase:
        authority.terminalState === 'FINALIZED'
          ? 'candidate-selected'
          : 'rollback-restored',
    },
    updatedAt: anchor.recordedAt,
    recordDigest: anchor.supervisorRecordDigest,
  };
  if (!isRecord(record)) throw supervisorNotTerminal();
  assertTerminalSelectionV2(paths, syntheticSupervisor, record, {
    allowSuccessorInventory: true,
  });
  const transaction = record.transaction;
  const envelope = record.envelope;
  if (
    !isRecord(transaction) ||
    !isRecord(envelope) ||
    !isRecord(envelope.payload)
  ) {
    throw supervisorNotTerminal();
  }
  const bundle = readCanonicalPrivateRecord(
    path.join(
      paths.bundles,
      `${identityFileName('control-plane-promotion', authority.grantId)}.json`,
    ),
    supervisorNotTerminal,
    MAX_PROMOTION_BUNDLE_BYTES,
  );
  if (!isRecord(bundle) || !isRecord(bundle.material)) {
    throw supervisorNotTerminal();
  }
  const material = bundle.material;
  const candidate = readFrozenControlPlaneCandidate(
    paths,
    initial.provenance,
    material,
    record.beforeManifest as Record<string, unknown>,
  );
  const selectedArtifact =
    authority.terminalState === 'FINALIZED'
      ? material.candidateArtifact
      : isRecord(material.recoveryBundle)
        ? material.recoveryBundle.restartArtifact
        : null;
  const expectedTrustCommit =
    authority.terminalState === 'FINALIZED'
      ? candidate.candidateCommit
      : initial.provenance.headOid;
  const expectedGeneration = authority.terminalState === 'FINALIZED' ? 2 : 3;
  if (
    !validEngineArtifactV2(selectedArtifact) ||
    authority.initialBootstrapPublishedDigest !== published.recordDigest ||
    authority.terminalState !== transaction.state ||
    authority.updateRecordDigest !== record.recordDigest ||
    authority.transactionJournalDigest !== transaction.journalDigest ||
    authority.grantEnvelopeDigest !== canonicalDigest(envelope) ||
    authority.promotionBundleDigest !== bundle.bundleDigest ||
    authority.txId !== transaction.txId ||
    envelope.payload.grantId !== authority.grantId ||
    anchor.generation !== expectedGeneration ||
    anchor.recordedAt !== record.updatedAt ||
    anchor.activeTrustCommit !== expectedTrustCommit ||
    canonicalJson(anchor.activeArtifact) !==
      canonicalJson({
        artifactId: selectedArtifact.artifactId,
        executableDigest: selectedArtifact.executableDigest,
        closureDigest:
          authority.terminalState === 'FINALIZED'
            ? transaction.afterClosureDigest
            : transaction.beforeClosureDigest,
      })
  ) {
    throw supervisorNotTerminal();
  }
  return initial.provenance;
}

function assertSingleV2ControlUpdateInventory(
  paths: BootstrapPaths,
  supervisor: BootstrapControlPlaneSupervisorState,
): void {
  // V2 does not sign a previous-supervisor digest or expected supervisor
  // generation. Until that lineage exists, only the single generation-one
  // promotion (or its immediate rollback) is independently reconstructible.
  const grantId = supervisor.transition?.grantId;
  if (grantId === undefined) throw supervisorNotTerminal();
  const expectedName = `${identityFileName('control-update', grantId)}.json`;
  const entries = fs.readdirSync(paths.controlUpdates, { withFileTypes: true });
  if (
    entries.length !== 1 ||
    entries[0]?.name !== expectedName ||
    !entries[0]?.isFile() ||
    entries[0]?.isSymbolicLink()
  ) {
    throw supervisorNotTerminal();
  }
}

function assertPromotionHasValidInitialBootstrapAnchor(
  paths: BootstrapPaths,
  repositoryId: string,
): InitialSupervisorBootstrapJournalRecord {
  assertPrivateDirectory(
    paths.initialBootstrapJournal,
    'CONTROL_PLANE_BOOTSTRAP_JOURNAL_CORRUPT',
  );
  const prepared = readInitialBootstrapJournalRecord(
    path.join(
      paths.initialBootstrapJournal,
      INITIAL_BOOTSTRAP_PHASE_FILES.PREPARED,
    ),
  );
  if (prepared.provenance.repositoryId !== repositoryId) {
    throw supervisorNotTerminal();
  }
  const initialSupervisor: BootstrapControlPlaneSupervisorState = {
    kind: 'control-plane-supervisor-state.v1',
    repositoryId,
    activeArtifact: prepared.activeArtifact,
    generation: 1,
    transition: null,
    updatedAt: prepared.initializedAt,
    recordDigest: prepared.supervisorRecordDigest,
  };
  assertInitialBootstrapTerminalSelection(paths, initialSupervisor);
  return prepared;
}

interface BootstrapTrustedSigner {
  identity: string;
  publicKey: string;
  fingerprint: string;
}

function assertV2PromotionHumanSignatures(
  paths: BootstrapPaths,
  initialProvenance: InitialSupervisorProvenance,
  material: Record<string, unknown>,
  reviewEnvelope: Record<string, unknown>,
  grantPayload: ReturnType<typeof assertedGrantPayloadV2>,
  grantSignature: string,
  beforeManifest: Record<string, unknown>,
): string {
  if (
    !isRecord(reviewEnvelope.payload) ||
    typeof reviewEnvelope.signature !== 'string' ||
    !isRecord(material.mandateBinding) ||
    !isDigest(material.frozenCandidateBundleDigest)
  ) {
    throw supervisorNotTerminal();
  }
  const candidate = readFrozenControlPlaneCandidate(
    paths,
    initialProvenance,
    material,
    beforeManifest,
  );
  const policy = readBootstrapMaintainerPolicyAt(
    initialProvenance.packageRoot,
    candidate.expectedOldCommit,
    grantPayload.repositoryId,
  );
  const reviewPayload = reviewEnvelope.payload;
  if (
    !isNonEmptyTrimmed(reviewPayload.reviewer) ||
    reviewPayload.reviewer === grantPayload.humanSigner
  ) {
    throw supervisorNotTerminal();
  }
  const reviewer = policy.trustedSigners.find(
    (signer) => signer.identity === reviewPayload.reviewer,
  );
  const grantSigner = policy.trustedSigners.find(
    (signer) => signer.identity === grantPayload.humanSigner,
  );
  if (reviewer === undefined || grantSigner === undefined) {
    throw supervisorNotTerminal();
  }
  verifyBootstrapSshSignature(
    `${canonicalJson(reviewPayload)}\n`,
    reviewEnvelope.signature,
    reviewer,
    CONTROL_PLANE_REVIEW_SIGNATURE_NAMESPACE_V2,
  );
  verifyBootstrapSshSignature(
    `${canonicalJson(grantPayload)}\n`,
    grantSignature,
    grantSigner,
    CONTROL_PLANE_SIGNATURE_NAMESPACE_V2,
  );

  const worktreeRoot = path.dirname(
    path.dirname(initialProvenance.packageRoot),
  );
  const remoteTip = readBootstrapRemoteBaseOid(
    worktreeRoot,
    initialProvenance.remoteBaseRef,
  );
  if (
    !bootstrapCommitIsAncestor(
      worktreeRoot,
      candidate.expectedOldCommit,
      remoteTip,
    )
  ) {
    throw supervisorNotTerminal();
  }
  return candidate.expectedOldCommit;
}

function assertV3PromotionHumanSignatures(
  paths: BootstrapPaths,
  initialProvenance: InitialSupervisorProvenance,
  material: Record<string, unknown>,
  lineage: ReturnType<typeof assertedPromotionLineageV3>,
  reviewEnvelope: Record<string, unknown>,
  grantPayload: ReturnType<typeof assertedGrantPayloadV3>,
  grantSignature: string,
  beforeManifest: Record<string, unknown>,
): Record<string, unknown> & {
  expectedOldCommit: string;
  candidateCommit: string;
} {
  if (
    !isRecord(reviewEnvelope.payload) ||
    typeof reviewEnvelope.signature !== 'string' ||
    !isRecord(material.mandateBinding) ||
    !isDigest(material.frozenCandidateBundleDigest)
  ) {
    throw supervisorNotTerminal();
  }
  const candidate = readFrozenControlPlaneCandidate(
    paths,
    initialProvenance,
    material,
    beforeManifest,
  );
  if (
    candidate.expectedOldCommit !== lineage.previousActiveTrustCommit ||
    candidate.candidateCommit !== lineage.candidateTrustCommit
  ) {
    throw supervisorNotTerminal();
  }
  const policy = readBootstrapMaintainerPolicyAt(
    initialProvenance.packageRoot,
    candidate.expectedOldCommit,
    grantPayload.repositoryId,
  );
  const reviewPayload = reviewEnvelope.payload;
  if (
    !isNonEmptyTrimmed(reviewPayload.reviewer) ||
    reviewPayload.reviewer === grantPayload.humanSigner
  ) {
    throw supervisorNotTerminal();
  }
  const reviewer = policy.trustedSigners.find(
    (signer) => signer.identity === reviewPayload.reviewer,
  );
  const grantSigner = policy.trustedSigners.find(
    (signer) => signer.identity === grantPayload.humanSigner,
  );
  if (reviewer === undefined || grantSigner === undefined) {
    throw supervisorNotTerminal();
  }
  verifyBootstrapSshSignature(
    `${canonicalJson(reviewPayload)}\n`,
    reviewEnvelope.signature,
    reviewer,
    CONTROL_PLANE_REVIEW_SIGNATURE_NAMESPACE_V3,
  );
  verifyBootstrapSshSignature(
    `${canonicalJson(grantPayload)}\n`,
    grantSignature,
    grantSigner,
    CONTROL_PLANE_SIGNATURE_NAMESPACE_V3,
  );
  const worktreeRoot = path.dirname(
    path.dirname(initialProvenance.packageRoot),
  );
  const remoteTip = readBootstrapRemoteBaseOid(
    worktreeRoot,
    initialProvenance.remoteBaseRef,
  );
  if (
    !bootstrapCommitIsAncestor(
      worktreeRoot,
      candidate.expectedOldCommit,
      remoteTip,
    )
  ) {
    throw supervisorNotTerminal();
  }
  return candidate;
}

function readFrozenControlPlaneCandidate(
  paths: BootstrapPaths,
  initialProvenance: InitialSupervisorProvenance,
  material: Record<string, unknown>,
  beforeManifest: Record<string, unknown>,
): Record<string, unknown> & {
  expectedOldCommit: string;
  candidateCommit: string;
} {
  const frozenDigest = material.frozenCandidateBundleDigest;
  if (
    !isDigest(frozenDigest) ||
    !isRecord(material.mandateBinding) ||
    !isNonEmptyTrimmed(material.repositoryId)
  ) {
    throw supervisorNotTerminal();
  }
  const worktreeRoot = path.dirname(
    path.dirname(initialProvenance.packageRoot),
  );
  const gitCommonDirectory = fs.realpathSync(
    exactBootstrapGitOutput(worktreeRoot, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ]),
  );
  if (bootstrapInterventionStateRoot(gitCommonDirectory) !== paths.root) {
    throw supervisorNotTerminal();
  }
  const candidateDirectory = path.join(
    gitCommonDirectory,
    'workflow-engine',
    'candidates',
  );
  assertPrivateDirectory(candidateDirectory, 'CONTROL_PLANE_STATE_UNSAFE');
  const candidate = readCanonicalPrivateRecord(
    path.join(
      candidateDirectory,
      `${frozenDigest.slice('sha256:'.length)}.json`,
    ),
    supervisorNotTerminal,
  );
  if (
    !isRecord(candidate) ||
    !hasExactKeys(candidate, [
      'candidateBundleDigest',
      'candidateCommit',
      'checksAttestation',
      'checksAttestationDigest',
      'classification',
      'commitMessage',
      'createdAt',
      'effectsManifestDigest',
      'expectedOldCommit',
      'expectedRefGeneration',
      'mandateBinding',
      'manifest',
      'manifestDigest',
      'providerInvocationsDigest',
      'recoveryPlanDigest',
      'repositoryId',
      'resultTree',
      'schemaVersion',
      'targetRef',
    ]) ||
    candidate.schemaVersion !== 1 ||
    candidate.classification !== 'control-plane' ||
    candidate.repositoryId !== material.repositoryId ||
    candidate.candidateBundleDigest !== frozenDigest.slice('sha256:'.length) ||
    !/^[0-9a-f]{64}$/.test(String(candidate.candidateBundleDigest)) ||
    !/^[0-9a-f]{40,64}$/.test(String(candidate.expectedOldCommit)) ||
    !/^[0-9a-f]{40,64}$/.test(String(candidate.candidateCommit)) ||
    !/^[0-9a-f]{40,64}$/.test(String(candidate.resultTree)) ||
    !Number.isSafeInteger(candidate.expectedRefGeneration) ||
    Number(candidate.expectedRefGeneration) < 0 ||
    !isNonEmptyTrimmed(candidate.targetRef) ||
    candidate.targetRef !== initialProvenance.branchRef ||
    !isCanonicalIso(candidate.createdAt) ||
    !validFrozenTaskMandateBinding(
      candidate.mandateBinding,
      material.mandateBinding,
    )
  ) {
    throw supervisorNotTerminal();
  }
  const { candidateBundleDigest: _candidateBundleDigest, ...candidateBody } =
    candidate;
  if (canonicalDigest(candidateBody) !== frozenDigest) {
    throw supervisorNotTerminal();
  }

  const expectedOldCommit = String(candidate.expectedOldCommit);
  const candidateCommit = String(candidate.candidateCommit);
  if (
    exactBootstrapGitOutput(worktreeRoot, [
      'rev-parse',
      '--verify',
      `${expectedOldCommit}^{commit}`,
    ]) !== expectedOldCommit ||
    exactBootstrapGitOutput(worktreeRoot, [
      'rev-parse',
      '--verify',
      `${candidateCommit}^{commit}`,
    ]) !== candidateCommit ||
    exactBootstrapGitOutput(worktreeRoot, [
      'rev-parse',
      '--verify',
      `${candidateCommit}^{tree}`,
    ]) !== candidate.resultTree ||
    !bootstrapCommitIsAncestor(
      worktreeRoot,
      initialProvenance.headOid,
      expectedOldCommit,
    )
  ) {
    throw supervisorNotTerminal();
  }
  const parents = exactBootstrapGitOutput(worktreeRoot, [
    'rev-list',
    '--parents',
    '-n',
    '1',
    candidateCommit,
  ]).split(' ');
  if (
    parents.length !== 2 ||
    parents[0] !== candidateCommit ||
    parents[1] !== expectedOldCommit ||
    !isRecord(material.candidateArtifact) ||
    material.candidateArtifact.sourceDigest !==
      frozenCandidateSourceDigestV2(expectedOldCommit, material.exactChanges)
  ) {
    throw supervisorNotTerminal();
  }

  const trustedManifest = verifiedProtectedCapabilityManifest(
    worktreeRoot,
    expectedOldCommit,
    false,
  );
  const { manifestDigest, ...beforeManifestPayload } = beforeManifest;
  if (
    trustedManifest.manifestDigest !== manifestDigest ||
    canonicalJson(trustedManifest.payload) !==
      canonicalJson(beforeManifestPayload)
  ) {
    throw supervisorNotTerminal();
  }
  return candidate as Record<string, unknown> & {
    expectedOldCommit: string;
    candidateCommit: string;
  };
}

function frozenCandidateSourceDigestV2(
  expectedOldCommit: string,
  changes: unknown,
): Sha256Digest {
  if (!validExactChangesV2(changes)) throw supervisorNotTerminal();
  const entries = changes.map((change) =>
    change.afterDigest === null
      ? { path: change.path, kind: 'deleted' as const }
      : {
          path: change.path,
          kind: 'file' as const,
          mode: change.afterMode,
          contentDigest: change.afterDigest,
        },
  );
  return canonicalDigest({
    kind: 'intervention-engine-source-snapshot.v1',
    head: expectedOldCommit,
    entries,
  });
}

function validFrozenTaskMandateBinding(
  frozen: unknown,
  material: Record<string, unknown>,
): boolean {
  return (
    isRecord(frozen) &&
    hasExactKeys(frozen, [
      'changeId',
      'externalAuditRoot',
      'mandateDigest',
      'mandateId',
      'mandateTaskId',
      'schemaVersion',
    ]) &&
    frozen.schemaVersion === 1 &&
    frozen.mandateTaskId === material.parentTaskId &&
    frozen.mandateId === material.mandateId &&
    frozen.mandateDigest === material.mandateDigest &&
    frozen.changeId === material.changeId &&
    frozen.externalAuditRoot === material.externalAuditRoot
  );
}

function readBootstrapMaintainerPolicyAt(
  packageRoot: string,
  revision: string,
  repositoryId: string,
): { trustedSigners: BootstrapTrustedSigner[] } {
  const worktreeRoot = path.dirname(path.dirname(packageRoot));
  const raw = exactBootstrapGitOutput(worktreeRoot, [
    'show',
    `${revision}:workflow/maintainer-policy.json`,
  ]);
  let policy: unknown;
  try {
    policy = JSON.parse(raw);
  } catch {
    throw supervisorNotTerminal();
  }
  if (
    !isRecord(policy) ||
    !hasExactKeys(policy, [
      'auditTagPrefix',
      'bootstrapEligiblePaths',
      'maxTtlMinutes',
      'maxUses',
      'phase',
      'repository',
      'requiredChecks',
      'schemaVersion',
      'sealedImmutablePaths',
      'signatureNamespace',
      'trustedSigners',
    ]) ||
    policy.schemaVersion !== 1 ||
    !isRecord(policy.repository) ||
    !hasExactKeys(policy.repository, ['id', 'origin']) ||
    policy.repository.id !== repositoryId ||
    typeof policy.repository.origin !== 'string' ||
    !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(
      policy.repository.origin,
    ) ||
    (policy.phase !== 'bootstrap' && policy.phase !== 'sealed') ||
    typeof policy.auditTagPrefix !== 'string' ||
    !/^refs\/tags\/[a-z0-9][a-z0-9-]*\/$/.test(policy.auditTagPrefix) ||
    policy.signatureNamespace !== 'expense-app.workflow.maintainer-grant.v1' ||
    policy.maxTtlMinutes !== 30 ||
    policy.maxUses !== 1 ||
    !sortedUniqueStrings(policy.bootstrapEligiblePaths, true) ||
    !sortedUniqueStrings(policy.sealedImmutablePaths, true) ||
    !sortedUniqueStrings(policy.requiredChecks, false) ||
    policy.requiredChecks.some(
      (checkId) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(checkId),
    ) ||
    !Array.isArray(policy.trustedSigners) ||
    policy.trustedSigners.length === 0
  ) {
    throw supervisorNotTerminal();
  }
  const trustedSigners: BootstrapTrustedSigner[] = [];
  for (const signer of policy.trustedSigners) {
    if (
      !isRecord(signer) ||
      !hasExactKeys(signer, ['fingerprint', 'identity', 'publicKey']) ||
      typeof signer.identity !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/.test(signer.identity) ||
      typeof signer.publicKey !== 'string' ||
      !/^ssh-(?:ed25519|ed25519-sk|rsa|ecdsa-[^ ]+) [A-Za-z0-9+/]+={0,2}$/.test(
        signer.publicKey,
      ) ||
      typeof signer.fingerprint !== 'string' ||
      !/^SHA256:[A-Za-z0-9+/]{20,}$/.test(signer.fingerprint)
    ) {
      throw supervisorNotTerminal();
    }
    trustedSigners.push({
      identity: signer.identity,
      publicKey: signer.publicKey,
      fingerprint: signer.fingerprint,
    });
  }
  if (
    !sortedUniqueStrings(
      trustedSigners.map(({ identity }) => identity),
      false,
    ) ||
    new Set(trustedSigners.map(({ publicKey }) => publicKey)).size !==
      trustedSigners.length ||
    new Set(trustedSigners.map(({ fingerprint }) => fingerprint)).size !==
      trustedSigners.length ||
    exactBootstrapGitOutput(worktreeRoot, [
      'config',
      '--local',
      '--get',
      'remote.origin.url',
    ]) !== policy.repository.origin
  ) {
    throw supervisorNotTerminal();
  }
  return { trustedSigners };
}

function verifyBootstrapSshSignature(
  payload: string,
  signature: string,
  signer: BootstrapTrustedSigner,
  namespace: string,
): void {
  const executable = bootstrapSshKeygenExecutable();
  const temporaryDirectory = fs.mkdtempSync(
    path.join(fs.realpathSync('/tmp'), 'workflow-bootstrap-verify-'),
  );
  fs.chmodSync(temporaryDirectory, PRIVATE_DIRECTORY_MODE);
  const allowedSignersPath = path.join(temporaryDirectory, 'allowed-signers');
  const signaturePath = path.join(temporaryDirectory, 'signature');
  try {
    fs.writeFileSync(
      allowedSignersPath,
      `${signer.identity} ${signer.publicKey}\n`,
      { mode: PRIVATE_FILE_MODE },
    );
    fs.writeFileSync(signaturePath, signature, {
      mode: PRIVATE_FILE_MODE,
    });
    const result = childProcess.spawnSync(
      executable,
      [
        '-Y',
        'verify',
        '-f',
        allowedSignersPath,
        '-I',
        signer.identity,
        '-n',
        namespace,
        '-s',
        signaturePath,
      ],
      {
        encoding: 'utf8',
        input: payload,
        shell: false,
        env: {
          PATH: `${path.dirname(executable)}:/usr/bin:/bin`,
          LANG: 'C',
          LC_ALL: 'C',
          TMPDIR: temporaryDirectory,
        },
        timeout: PROCESS_TIMEOUT_MS,
        maxBuffer: PROCESS_MAX_BUFFER_BYTES,
        windowsHide: true,
      },
    );
    if (
      result.error !== undefined ||
      result.signal !== null ||
      result.status !== 0
    ) {
      throw supervisorNotTerminal();
    }
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function bootstrapSshKeygenExecutable(): string {
  if (process.platform === 'win32') throw supervisorNotTerminal();
  for (const candidate of ['/usr/bin/ssh-keygen', '/bin/ssh-keygen']) {
    const stats = fs.lstatSync(candidate, { throwIfNoEntry: false });
    if (stats?.isFile() && !stats.isSymbolicLink()) {
      return fs.realpathSync(candidate);
    }
  }
  throw supervisorNotTerminal();
}

function validTerminalObservationsV2(
  history: unknown,
  observations: unknown,
  createdAt: unknown,
  updatedAt: unknown,
): boolean {
  if (
    !Array.isArray(history) ||
    !Array.isArray(observations) ||
    history.length !== observations.length + 1 ||
    history.length < 2 ||
    !isRecord(history[0]) ||
    history[0].at !== createdAt ||
    !isRecord(history.at(-1)) ||
    history.at(-1)?.at !== updatedAt
  ) {
    return false;
  }
  const eventForTransition: Record<string, string> = {
    'PREPARED\0OLD_CLOSURE_VERIFIED': 'old-closure-verified',
    'OLD_CLOSURE_VERIFIED\0CANDIDATE_VERIFIED': 'candidate-verified',
    'CANDIDATE_VERIFIED\0RECOVERY_VERIFIED': 'recovery-bundle-verified',
    'RECOVERY_VERIFIED\0SWITCHED': 'atomic-switch-completed',
    'SWITCHED\0SELF_TESTED': 'self-tests-passed',
    'SWITCHED\0ROLLBACK_REQUIRED': 'self-tests-failed',
    'SELF_TESTED\0FINALIZED': 'finalize',
    'ROLLBACK_REQUIRED\0ROLLED_BACK': 'rollback-completed',
  };
  return observations.every((observation, index) => {
    const before = history[index];
    const after = history[index + 1];
    if (
      !isRecord(observation) ||
      !isRecord(before) ||
      !isRecord(after) ||
      !hasExactKeys(observation, [
        'evidenceDigest',
        'eventKind',
        'fromState',
        'recordedAt',
        'sequence',
        'toState',
      ])
    ) {
      return false;
    }
    return (
      observation.sequence === index + 1 &&
      observation.fromState === before.state &&
      observation.toState === after.state &&
      observation.eventKind ===
        eventForTransition[`${String(before.state)}\0${String(after.state)}`] &&
      observation.recordedAt === after.at &&
      isDigest(observation.evidenceDigest)
    );
  });
}

function validControlPlaneGrantPayloadV2(
  payload: Record<string, unknown>,
): payload is Record<string, unknown> & {
  affectedCapabilities: string[];
  afterClosureDigest: Sha256Digest;
  beforeClosureDigest: Sha256Digest;
  candidateDigest: Sha256Digest;
  exactChanges: Array<Record<string, unknown>>;
  expiresAt: string;
  grantId: string;
  humanSigner: string;
  independentReviewAttestationDigest: Sha256Digest;
  issuedAt: string;
  mandateBinding: Record<string, unknown>;
  promotionBundleDigest: Sha256Digest;
  promotionMaterialDigest: Sha256Digest;
  recoveryBundle: Record<string, unknown> & {
    bundleDigest: Sha256Digest;
  };
  repositoryId: string;
  updaterVersion: 2;
} {
  if (
    !hasExactKeys(payload, [
      'affectedCapabilities',
      'afterClosureDigest',
      'beforeClosureDigest',
      'behaviorChangeSummary',
      'candidateDigest',
      'exactChanges',
      'expiresAt',
      'frozenCandidateBundleDigest',
      'grantId',
      'humanSigner',
      'independentReviewAttestationDigest',
      'issuedAt',
      'kind',
      'mandateBinding',
      'oneShot',
      'promotionBundleDigest',
      'promotionMaterialDigest',
      'recoveryBundle',
      'repositoryId',
      'updaterVersion',
    ]) ||
    payload.kind !== 'control-plane-grant.v2' ||
    payload.oneShot !== true ||
    payload.updaterVersion !== 2 ||
    !isNonEmptyTrimmed(payload.grantId) ||
    !isNonEmptyTrimmed(payload.repositoryId) ||
    !isNonEmptyTrimmed(payload.behaviorChangeSummary) ||
    !isNonEmptyTrimmed(payload.humanSigner) ||
    !validTaskMandateBindingV2(payload.mandateBinding) ||
    !validExactChangesV2(payload.exactChanges) ||
    !validAffectedCapabilitiesV2(payload.affectedCapabilities) ||
    !isDigest(payload.frozenCandidateBundleDigest) ||
    !isDigest(payload.candidateDigest) ||
    !isDigest(payload.promotionMaterialDigest) ||
    !isDigest(payload.promotionBundleDigest) ||
    !isDigest(payload.beforeClosureDigest) ||
    !isDigest(payload.afterClosureDigest) ||
    !isDigest(payload.independentReviewAttestationDigest) ||
    payload.candidateDigest !==
      canonicalDigest({
        kind: 'control-plane-candidate.v2',
        changes: payload.exactChanges,
      }) ||
    !isCanonicalIso(payload.issuedAt) ||
    !isCanonicalIso(payload.expiresAt)
  ) {
    return false;
  }
  const lifetime = Date.parse(payload.expiresAt) - Date.parse(payload.issuedAt);
  if (lifetime <= 0 || lifetime > CONTROL_PLANE_GRANT_V2_MAX_TTL_MS) {
    return false;
  }
  if (
    !isRecord(payload.recoveryBundle) ||
    !hasExactKeys(payload.recoveryBundle, [
      'bundleDigest',
      'previousClosureDigest',
      'restartArtifactDigest',
      'rollbackTestReportDigest',
    ]) ||
    !isDigest(payload.recoveryBundle.bundleDigest) ||
    !isDigest(payload.recoveryBundle.previousClosureDigest) ||
    !isDigest(payload.recoveryBundle.restartArtifactDigest) ||
    !isDigest(payload.recoveryBundle.rollbackTestReportDigest) ||
    payload.recoveryBundle.previousClosureDigest !== payload.beforeClosureDigest
  ) {
    return false;
  }
  return true;
}

function validControlPlaneGrantPayloadV3(
  payload: Record<string, unknown>,
): payload is Record<string, unknown> & {
  affectedCapabilities: string[];
  afterClosureDigest: Sha256Digest;
  beforeClosureDigest: Sha256Digest;
  candidateDigest: Sha256Digest;
  exactChanges: Array<Record<string, unknown>>;
  expiresAt: string;
  grantId: string;
  humanSigner: string;
  independentReviewAttestationDigest: Sha256Digest;
  issuedAt: string;
  mandateBinding: Record<string, unknown>;
  promotionBundleDigest: Sha256Digest;
  promotionLineageDigest: Sha256Digest;
  promotionMaterialDigest: Sha256Digest;
  recoveryBundle: Record<string, unknown> & {
    bundleDigest: Sha256Digest;
  };
  repositoryId: string;
  updaterVersion: 3;
} {
  if (
    !hasExactKeys(payload, [
      'affectedCapabilities',
      'afterClosureDigest',
      'beforeClosureDigest',
      'behaviorChangeSummary',
      'candidateDigest',
      'exactChanges',
      'expiresAt',
      'frozenCandidateBundleDigest',
      'grantId',
      'humanSigner',
      'independentReviewAttestationDigest',
      'issuedAt',
      'kind',
      'mandateBinding',
      'oneShot',
      'promotionBundleDigest',
      'promotionLineageDigest',
      'promotionMaterialDigest',
      'recoveryBundle',
      'repositoryId',
      'updaterVersion',
    ]) ||
    payload.kind !== 'control-plane-grant.v3' ||
    payload.updaterVersion !== 3 ||
    !isDigest(payload.promotionLineageDigest)
  ) {
    return false;
  }
  const { promotionLineageDigest: _lineageDigest, ...rest } = payload;
  return validControlPlaneGrantPayloadV2({
    ...rest,
    kind: 'control-plane-grant.v2',
    updaterVersion: 2,
  });
}

function assertedGrantPayloadV3(value: Record<string, unknown>): Record<
  string,
  unknown
> & {
  affectedCapabilities: string[];
  afterClosureDigest: Sha256Digest;
  beforeClosureDigest: Sha256Digest;
  candidateDigest: Sha256Digest;
  exactChanges: Array<Record<string, unknown>>;
  grantId: string;
  humanSigner: string;
  independentReviewAttestationDigest: Sha256Digest;
  issuedAt: string;
  mandateBinding: Record<string, unknown>;
  promotionBundleDigest: Sha256Digest;
  promotionLineageDigest: Sha256Digest;
  promotionMaterialDigest: Sha256Digest;
  recoveryBundle: Record<string, unknown> & {
    bundleDigest: Sha256Digest;
  };
  repositoryId: string;
} {
  if (!validControlPlaneGrantPayloadV3(value)) throw supervisorNotTerminal();
  return value;
}

function validPromotionLineageV3(value: unknown): value is Record<
  string,
  unknown
> & {
  historyAnchorDigest: Sha256Digest;
  previousTerminalRecordDigest: Sha256Digest;
  previousSupervisorRecordDigest: Sha256Digest;
  previousGeneration: number;
  candidateGeneration: number;
  rollbackGeneration: number;
  previousActiveTrustCommit: string;
  candidateTrustCommit: string;
  lineageDigest: Sha256Digest;
} {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'candidateGeneration',
      'candidateTrustCommit',
      'historyAnchorDigest',
      'kind',
      'lineageDigest',
      'previousActiveTrustCommit',
      'previousGeneration',
      'previousSupervisorRecordDigest',
      'previousTerminalRecordDigest',
      'rollbackGeneration',
    ]) ||
    value.kind !== 'control-plane-promotion-lineage.v1' ||
    !isDigest(value.historyAnchorDigest) ||
    !isDigest(value.previousTerminalRecordDigest) ||
    !isDigest(value.previousSupervisorRecordDigest) ||
    !isDigest(value.lineageDigest) ||
    !positiveSafeInteger(value.previousGeneration) ||
    value.candidateGeneration !== Number(value.previousGeneration) + 1 ||
    value.rollbackGeneration !== Number(value.previousGeneration) + 2 ||
    !isGitObjectId(value.previousActiveTrustCommit) ||
    !isGitObjectId(value.candidateTrustCommit)
  ) {
    return false;
  }
  const { lineageDigest, ...payload } = value;
  return canonicalDigest(payload) === lineageDigest;
}

function validPromotionBundleV3(
  bundle: Record<string, unknown>,
  grant: ReturnType<typeof assertedGrantPayloadV3>,
  beforeManifest: Record<string, unknown>,
  afterManifest: Record<string, unknown>,
): bundle is Record<string, unknown> & {
  independentReviewAttestation: Record<string, unknown>;
  lineage: ReturnType<typeof assertedPromotionLineageV3>;
  material: Record<string, unknown> & {
    affectedCapabilities: string[];
    candidateArtifact: Record<string, unknown>;
    candidateExecutableBase64: string;
    recoveryBundle: Record<string, unknown> & {
      restartArtifact: Record<string, unknown>;
      restartExecutableBase64: string;
    };
  };
  bundleDigest: Sha256Digest;
  promotionLineageDigest: Sha256Digest;
} {
  if (
    !hasExactKeys(bundle, [
      'bundleDigest',
      'independentReviewAttestation',
      'kind',
      'lineage',
      'material',
      'promotionLineageDigest',
      'promotionMaterialDigest',
    ]) ||
    bundle.kind !== 'control-plane-promotion-bundle.v3' ||
    !isRecord(bundle.material) ||
    !isRecord(bundle.independentReviewAttestation) ||
    !validPromotionLineageV3(bundle.lineage) ||
    !isDigest(bundle.promotionMaterialDigest) ||
    !isDigest(bundle.promotionLineageDigest) ||
    !isDigest(bundle.bundleDigest)
  ) {
    return false;
  }
  const { bundleDigest, ...bundlePayload } = bundle;
  if (
    canonicalDigest(bundlePayload) !== bundleDigest ||
    canonicalDigest(bundle.material) !== bundle.promotionMaterialDigest ||
    bundle.promotionLineageDigest !== bundle.lineage.lineageDigest ||
    bundle.bundleDigest !== grant.promotionBundleDigest ||
    bundle.promotionMaterialDigest !== grant.promotionMaterialDigest ||
    bundle.promotionLineageDigest !== grant.promotionLineageDigest ||
    !validPromotionMaterialV2(
      bundle.material,
      grant,
      beforeManifest,
      afterManifest,
    ) ||
    !validIndependentReviewV3(
      bundle.independentReviewAttestation,
      bundle.material,
      bundle.lineage,
      bundle.promotionMaterialDigest,
      grant,
    )
  ) {
    return false;
  }
  return true;
}

function assertedPromotionLineageV3(value: unknown): Record<string, unknown> & {
  historyAnchorDigest: Sha256Digest;
  previousTerminalRecordDigest: Sha256Digest;
  previousSupervisorRecordDigest: Sha256Digest;
  previousGeneration: number;
  candidateGeneration: number;
  rollbackGeneration: number;
  previousActiveTrustCommit: string;
  candidateTrustCommit: string;
  lineageDigest: Sha256Digest;
} {
  if (!validPromotionLineageV3(value)) throw supervisorNotTerminal();
  return value;
}

function validIndependentReviewV3(
  envelope: Record<string, unknown>,
  material: Record<string, unknown>,
  lineage: ReturnType<typeof assertedPromotionLineageV3>,
  materialDigest: Sha256Digest,
  grant: ReturnType<typeof assertedGrantPayloadV3>,
): boolean {
  if (
    !hasExactKeys(envelope, ['payload', 'signature']) ||
    !isRecord(envelope.payload) ||
    !validBoundedSignature(envelope.signature)
  ) {
    return false;
  }
  const review = envelope.payload;
  return (
    hasExactKeys(review, [
      'affectedCapabilities',
      'afterClosureDigest',
      'beforeClosureDigest',
      'candidateDigest',
      'frozenCandidateBundleDigest',
      'kind',
      'promotionLineageDigest',
      'promotionMaterialDigest',
      'recoveryBundleDigest',
      'repositoryId',
      'reviewSummary',
      'reviewedAt',
      'reviewer',
      'verdict',
    ]) &&
    review.kind === 'control-plane-independent-review.v3' &&
    review.verdict === 'approved' &&
    isNonEmptyTrimmed(review.repositoryId) &&
    isNonEmptyTrimmed(review.reviewSummary) &&
    isNonEmptyTrimmed(review.reviewer) &&
    isCanonicalIso(review.reviewedAt) &&
    validAffectedCapabilitiesV2(review.affectedCapabilities) &&
    isDigest(review.promotionLineageDigest) &&
    review.repositoryId === material.repositoryId &&
    review.frozenCandidateBundleDigest ===
      material.frozenCandidateBundleDigest &&
    review.candidateDigest === material.candidateDigest &&
    review.promotionMaterialDigest === materialDigest &&
    review.promotionLineageDigest === lineage.lineageDigest &&
    review.beforeClosureDigest === material.beforeClosureDigest &&
    review.afterClosureDigest === material.afterClosureDigest &&
    isRecord(material.recoveryBundle) &&
    review.recoveryBundleDigest === material.recoveryBundle.bundleDigest &&
    canonicalJson(review.affectedCapabilities) ===
      canonicalJson(material.affectedCapabilities) &&
    canonicalDigest(envelope) === grant.independentReviewAttestationDigest &&
    Date.parse(String(review.reviewedAt)) <= Date.parse(grant.issuedAt) &&
    review.reviewer !== grant.humanSigner
  );
}

function validPromotionBundleV2(
  bundle: Record<string, unknown>,
  grant: ReturnType<typeof assertedGrantPayloadV2>,
  beforeManifest: Record<string, unknown>,
  afterManifest: Record<string, unknown>,
): bundle is Record<string, unknown> & {
  independentReviewAttestation: Record<string, unknown>;
  material: Record<string, unknown> & {
    affectedCapabilities: string[];
    candidateArtifact: Record<string, unknown>;
    candidateExecutableBase64: string;
    recoveryBundle: Record<string, unknown> & {
      restartArtifact: Record<string, unknown>;
      restartExecutableBase64: string;
    };
  };
} {
  if (
    !hasExactKeys(bundle, [
      'bundleDigest',
      'independentReviewAttestation',
      'kind',
      'material',
      'promotionMaterialDigest',
    ]) ||
    bundle.kind !== 'control-plane-promotion-bundle.v2' ||
    !isRecord(bundle.material) ||
    !isRecord(bundle.independentReviewAttestation) ||
    !isDigest(bundle.promotionMaterialDigest) ||
    !isDigest(bundle.bundleDigest)
  ) {
    return false;
  }
  const { bundleDigest, ...bundlePayload } = bundle;
  if (
    canonicalDigest(bundlePayload) !== bundleDigest ||
    canonicalDigest(bundle.material) !== bundle.promotionMaterialDigest ||
    bundle.bundleDigest !== grant.promotionBundleDigest ||
    bundle.promotionMaterialDigest !== grant.promotionMaterialDigest ||
    !validPromotionMaterialV2(
      bundle.material,
      grant,
      beforeManifest,
      afterManifest,
    ) ||
    !validIndependentReviewV2(
      bundle.independentReviewAttestation,
      bundle.material,
      bundle.promotionMaterialDigest,
      grant,
    )
  ) {
    return false;
  }
  return true;
}

function assertedGrantPayloadV2(value: Record<string, unknown>): Record<
  string,
  unknown
> & {
  affectedCapabilities: string[];
  afterClosureDigest: Sha256Digest;
  beforeClosureDigest: Sha256Digest;
  candidateDigest: Sha256Digest;
  exactChanges: Array<Record<string, unknown>>;
  humanSigner: string;
  independentReviewAttestationDigest: Sha256Digest;
  issuedAt: string;
  mandateBinding: Record<string, unknown>;
  promotionBundleDigest: Sha256Digest;
  promotionMaterialDigest: Sha256Digest;
  recoveryBundle: Record<string, unknown>;
  repositoryId: string;
} {
  if (!validControlPlaneGrantPayloadV2(value)) throw supervisorNotTerminal();
  return value;
}

function validPromotionMaterialV2(
  material: Record<string, unknown>,
  grant: ReturnType<typeof assertedGrantPayloadV2>,
  beforeManifest: Record<string, unknown>,
  afterManifest: Record<string, unknown>,
): boolean {
  if (
    !hasExactKeys(material, [
      'affectedCapabilities',
      'afterClosureDigest',
      'beforeClosureDigest',
      'behaviorChangeSummary',
      'candidateArtifact',
      'candidateDigest',
      'candidateExecutableBase64',
      'candidateExecutableProvenanceDigest',
      'candidateFiles',
      'exactChanges',
      'frozenCandidateBundleDigest',
      'kind',
      'mandateBinding',
      'recoveryBundle',
      'repositoryId',
    ]) ||
    material.kind !== 'control-plane-promotion-material.v1' ||
    !isNonEmptyTrimmed(material.repositoryId) ||
    !isNonEmptyTrimmed(material.behaviorChangeSummary) ||
    !validTaskMandateBindingV2(material.mandateBinding) ||
    !validExactChangesV2(material.exactChanges) ||
    !validAffectedCapabilitiesV2(material.affectedCapabilities) ||
    !isDigest(material.frozenCandidateBundleDigest) ||
    !isDigest(material.candidateDigest) ||
    !isDigest(material.beforeClosureDigest) ||
    !isDigest(material.afterClosureDigest) ||
    !isDigest(material.candidateExecutableProvenanceDigest) ||
    material.repositoryId !== grant.repositoryId ||
    material.frozenCandidateBundleDigest !==
      grant.frozenCandidateBundleDigest ||
    material.candidateDigest !== grant.candidateDigest ||
    material.beforeClosureDigest !== grant.beforeClosureDigest ||
    material.afterClosureDigest !== grant.afterClosureDigest ||
    material.behaviorChangeSummary !== grant.behaviorChangeSummary ||
    canonicalJson(material.mandateBinding) !==
      canonicalJson(grant.mandateBinding) ||
    canonicalJson(material.exactChanges) !==
      canonicalJson(grant.exactChanges) ||
    canonicalJson(material.affectedCapabilities) !==
      canonicalJson(grant.affectedCapabilities) ||
    material.beforeClosureDigest !== beforeManifest.manifestDigest ||
    material.afterClosureDigest !== afterManifest.manifestDigest ||
    material.candidateDigest !==
      canonicalDigest({
        kind: 'control-plane-candidate.v2',
        changes: material.exactChanges,
      }) ||
    !validEngineArtifactV2(material.candidateArtifact) ||
    material.candidateArtifact.sourceChangeId !==
      material.mandateBinding.changeId
  ) {
    return false;
  }
  const candidateExecutable = canonicalBase64Bytes(
    material.candidateExecutableBase64,
    MAX_PROMOTION_FILE_BYTES,
    false,
  );
  if (
    candidateExecutable === null ||
    rawDigest(candidateExecutable) !==
      material.candidateArtifact.executableDigest ||
    !validPromotionFilesV2(
      material.candidateFiles,
      material.exactChanges,
      'after',
    ) ||
    !validRecoveryMaterialV2(
      material.recoveryBundle,
      material.exactChanges,
      material.repositoryId,
      material.beforeClosureDigest,
      grant,
    )
  ) {
    return false;
  }
  return true;
}

function validRecoveryMaterialV2(
  recovery: unknown,
  changes: Array<Record<string, unknown>>,
  repositoryId: string,
  beforeClosureDigest: Sha256Digest,
  grant: ReturnType<typeof assertedGrantPayloadV2>,
): recovery is Record<string, unknown> & {
  restartArtifact: Record<string, unknown>;
  restartExecutableBase64: string;
} {
  if (
    !isRecord(recovery) ||
    !hasExactKeys(recovery, [
      'bundleDigest',
      'kind',
      'previousClosureDigest',
      'previousFiles',
      'repositoryId',
      'restartArtifact',
      'restartExecutableBase64',
      'restartExecutableProvenanceDigest',
      'rollbackTestReportBase64',
      'rollbackTestReportDigest',
    ]) ||
    recovery.kind !== 'control-plane-recovery-bundle.v2' ||
    recovery.repositoryId !== repositoryId ||
    recovery.previousClosureDigest !== beforeClosureDigest ||
    !isDigest(recovery.restartExecutableProvenanceDigest) ||
    !isDigest(recovery.rollbackTestReportDigest) ||
    !isDigest(recovery.bundleDigest) ||
    !validEngineArtifactV2(recovery.restartArtifact) ||
    !validPromotionFilesV2(recovery.previousFiles, changes, 'before')
  ) {
    return false;
  }
  const restartExecutable = canonicalBase64Bytes(
    recovery.restartExecutableBase64,
    MAX_PROMOTION_FILE_BYTES,
    false,
  );
  const rollbackReport = canonicalBase64Bytes(
    recovery.rollbackTestReportBase64,
    MAX_PROMOTION_FILE_BYTES,
    true,
  );
  const { bundleDigest, ...recoveryPayload } = recovery;
  return (
    restartExecutable !== null &&
    rollbackReport !== null &&
    rawDigest(restartExecutable) ===
      recovery.restartArtifact.executableDigest &&
    rawDigest(rollbackReport) === recovery.rollbackTestReportDigest &&
    canonicalDigest(recoveryPayload) === bundleDigest &&
    grant.recoveryBundle.bundleDigest === bundleDigest &&
    grant.recoveryBundle.previousClosureDigest === beforeClosureDigest &&
    grant.recoveryBundle.restartArtifactDigest ===
      recovery.restartArtifact.executableDigest &&
    grant.recoveryBundle.rollbackTestReportDigest ===
      recovery.rollbackTestReportDigest
  );
}

function validIndependentReviewV2(
  envelope: Record<string, unknown>,
  material: Record<string, unknown>,
  materialDigest: Sha256Digest,
  grant: ReturnType<typeof assertedGrantPayloadV2>,
): boolean {
  if (
    !hasExactKeys(envelope, ['payload', 'signature']) ||
    !isRecord(envelope.payload) ||
    !validBoundedSignature(envelope.signature)
  ) {
    return false;
  }
  const review = envelope.payload;
  return (
    hasExactKeys(review, [
      'affectedCapabilities',
      'afterClosureDigest',
      'beforeClosureDigest',
      'candidateDigest',
      'frozenCandidateBundleDigest',
      'kind',
      'promotionMaterialDigest',
      'recoveryBundleDigest',
      'repositoryId',
      'reviewSummary',
      'reviewedAt',
      'reviewer',
      'verdict',
    ]) &&
    review.kind === 'control-plane-independent-review.v2' &&
    review.verdict === 'approved' &&
    isNonEmptyTrimmed(review.repositoryId) &&
    isNonEmptyTrimmed(review.reviewSummary) &&
    isNonEmptyTrimmed(review.reviewer) &&
    isCanonicalIso(review.reviewedAt) &&
    validAffectedCapabilitiesV2(review.affectedCapabilities) &&
    review.repositoryId === material.repositoryId &&
    review.frozenCandidateBundleDigest ===
      material.frozenCandidateBundleDigest &&
    review.candidateDigest === material.candidateDigest &&
    review.promotionMaterialDigest === materialDigest &&
    review.beforeClosureDigest === material.beforeClosureDigest &&
    review.afterClosureDigest === material.afterClosureDigest &&
    isRecord(material.recoveryBundle) &&
    review.recoveryBundleDigest === material.recoveryBundle.bundleDigest &&
    canonicalJson(review.affectedCapabilities) ===
      canonicalJson(material.affectedCapabilities) &&
    canonicalDigest(envelope) === grant.independentReviewAttestationDigest &&
    Date.parse(review.reviewedAt) <= Date.parse(grant.issuedAt) &&
    review.reviewer !== grant.humanSigner
  );
}

function validTaskMandateBindingV2(
  value: unknown,
): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'changeId',
      'externalAuditRoot',
      'mandateDigest',
      'mandateId',
      'parentTaskId',
      'schemaVersion',
    ]) &&
    value.schemaVersion === 1 &&
    typeof value.parentTaskId === 'string' &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.parentTaskId) &&
    typeof value.mandateId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value.mandateId,
    ) &&
    typeof value.mandateDigest === 'string' &&
    /^[0-9a-f]{64}$/.test(value.mandateDigest) &&
    typeof value.changeId === 'string' &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.changeId) &&
    typeof value.externalAuditRoot === 'string' &&
    path.isAbsolute(value.externalAuditRoot) &&
    path.normalize(value.externalAuditRoot) === value.externalAuditRoot &&
    value.externalAuditRoot !== path.parse(value.externalAuditRoot).root
  );
}

function validEngineArtifactV2(value: unknown): value is Record<
  string,
  unknown
> & {
  artifactId: Sha256Digest;
  executableDigest: Sha256Digest;
  sourceChangeId: string;
} {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'artifactId',
      'canReadSessionSchemas',
      'executableDigest',
      'kind',
      'policySchemaVersion',
      'protocolVersion',
      'smokeReportDigest',
      'sourceChangeId',
      'sourceDigest',
      'writesSessionSchema',
    ]) ||
    value.kind !== 'engine-artifact.v1' ||
    !isNonEmptyTrimmed(value.sourceChangeId) ||
    !isDigest(value.sourceDigest) ||
    !isDigest(value.executableDigest) ||
    !isDigest(value.smokeReportDigest) ||
    !isDigest(value.artifactId) ||
    !Number.isSafeInteger(value.protocolVersion) ||
    Number(value.protocolVersion) < 1 ||
    !Number.isSafeInteger(value.policySchemaVersion) ||
    Number(value.policySchemaVersion) < 1 ||
    !isNonEmptyTrimmed(value.writesSessionSchema) ||
    !sortedUniqueStrings(value.canReadSessionSchemas, false) ||
    !value.canReadSessionSchemas.includes(value.writesSessionSchema)
  ) {
    return false;
  }
  const { artifactId, ...payload } = value;
  return canonicalDigest(payload) === artifactId;
}

function validExactChangesV2(
  value: unknown,
): value is Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.length === 0) return false;
  const paths: string[] = [];
  for (const change of value) {
    if (
      !isRecord(change) ||
      !hasExactKeys(change, [
        'afterDigest',
        'afterMode',
        'beforeDigest',
        'beforeMode',
        'path',
      ]) ||
      !safeClosurePath(change.path)
    ) {
      return false;
    }
    const beforePresent = change.beforeDigest !== null;
    const afterPresent = change.afterDigest !== null;
    if (
      (beforePresent && !isDigest(change.beforeDigest)) ||
      (afterPresent && !isDigest(change.afterDigest)) ||
      beforePresent !== (change.beforeMode !== null) ||
      afterPresent !== (change.afterMode !== null) ||
      (change.beforeMode !== null &&
        change.beforeMode !== '100644' &&
        change.beforeMode !== '100755') ||
      (change.afterMode !== null &&
        change.afterMode !== '100644' &&
        change.afterMode !== '100755') ||
      (!beforePresent && !afterPresent) ||
      (change.beforeDigest === change.afterDigest &&
        change.beforeMode === change.afterMode)
    ) {
      return false;
    }
    paths.push(change.path);
  }
  return sortedUniqueStrings(paths, false);
}

function validPromotionFilesV2(
  value: unknown,
  changes: Array<Record<string, unknown>>,
  side: 'before' | 'after',
): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  let totalBytes = 0;
  const observed: Array<Record<string, unknown>> = [];
  for (const file of value) {
    if (
      !isRecord(file) ||
      !hasExactKeys(file, ['contentBase64', 'contentDigest', 'mode', 'path']) ||
      !safeClosurePath(file.path) ||
      (file.mode !== '100644' && file.mode !== '100755') ||
      !isDigest(file.contentDigest)
    ) {
      return false;
    }
    const bytes = canonicalBase64Bytes(
      file.contentBase64,
      MAX_PROMOTION_FILE_BYTES,
      true,
    );
    if (bytes === null || rawDigest(bytes) !== file.contentDigest) return false;
    totalBytes += bytes.length;
    if (totalBytes > MAX_PROMOTION_TOTAL_BYTES) return false;
    observed.push({
      path: file.path,
      mode: file.mode,
      contentDigest: file.contentDigest,
    });
  }
  const expected = changes
    .filter((change) =>
      side === 'before'
        ? change.beforeDigest !== null
        : change.afterDigest !== null,
    )
    .map((change) => ({
      path: change.path,
      mode: side === 'before' ? change.beforeMode : change.afterMode,
      contentDigest:
        side === 'before' ? change.beforeDigest : change.afterDigest,
    }));
  return canonicalJson(observed) === canonicalJson(expected);
}

function validProtectedCapabilityManifestV2(
  value: Record<string, unknown>,
): boolean {
  if (
    !hasExactKeys(value, [
      'entries',
      'kind',
      'manifestDigest',
      'manifestPath',
      'schemaVersion',
    ]) ||
    value.kind !== 'protected-capability-manifest.v1' ||
    value.schemaVersion !== 1 ||
    !safeClosurePath(value.manifestPath) ||
    !Array.isArray(value.entries) ||
    value.entries.length !== REQUIRED_BOOTSTRAP_PROTECTED_CAPABILITIES.length ||
    !isDigest(value.manifestDigest)
  ) {
    return false;
  }
  const capabilities: string[] = [];
  for (const entry of value.entries) {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, [
        'capability',
        'closureDigest',
        'contentDigest',
        'dependencies',
        'entrypoints',
      ]) ||
      typeof entry.capability !== 'string' ||
      !REQUIRED_BOOTSTRAP_PROTECTED_CAPABILITIES.includes(
        entry.capability as (typeof REQUIRED_BOOTSTRAP_PROTECTED_CAPABILITIES)[number],
      ) ||
      !sortedUniqueSafePaths(entry.entrypoints, false) ||
      entry.entrypoints.length === 0 ||
      !sortedUniqueSafePaths(entry.dependencies, true) ||
      !isDigest(entry.contentDigest) ||
      !isDigest(entry.closureDigest) ||
      entry.closureDigest !==
        canonicalDigest({
          entrypoints: entry.entrypoints,
          dependencies: entry.dependencies,
          contentDigest: entry.contentDigest,
        })
    ) {
      return false;
    }
    capabilities.push(entry.capability);
  }
  const { manifestDigest, ...payload } = value;
  return (
    canonicalJson(capabilities) ===
      canonicalJson(REQUIRED_BOOTSTRAP_PROTECTED_CAPABILITIES) &&
    canonicalDigest(payload) === manifestDigest
  );
}

function affectedCapabilitiesForV2(
  beforeManifest: Record<string, unknown>,
  afterManifest: Record<string, unknown>,
  changes: Array<Record<string, unknown>>,
): string[] | null {
  if (
    !Array.isArray(beforeManifest.entries) ||
    !Array.isArray(afterManifest.entries) ||
    typeof beforeManifest.manifestPath !== 'string'
  ) {
    return null;
  }
  const changed = new Set(changes.map((change) => String(change.path)));
  const manifestChanged =
    changed.has(beforeManifest.manifestPath) ||
    beforeManifest.manifestDigest !== afterManifest.manifestDigest;
  const affected: string[] = [];
  for (const capability of REQUIRED_BOOTSTRAP_PROTECTED_CAPABILITIES) {
    const before = beforeManifest.entries.find(
      (entry) => isRecord(entry) && entry.capability === capability,
    );
    const after = afterManifest.entries.find(
      (entry) => isRecord(entry) && entry.capability === capability,
    );
    if (!isRecord(before) || !isRecord(after)) return null;
    const protectedPaths = new Set([
      ...(before.entrypoints as string[]),
      ...(before.dependencies as string[]),
      ...(after.entrypoints as string[]),
      ...(after.dependencies as string[]),
    ]);
    if (
      before.closureDigest !== after.closureDigest ||
      [...changed].some((filePath) => protectedPaths.has(filePath))
    ) {
      affected.push(capability);
    }
  }
  return manifestChanged || affected.length > 0 ? affected : null;
}

function validAffectedCapabilitiesV2(value: unknown): value is string[] {
  return (
    sortedUniqueStrings(value, true) &&
    value.every((capability) =>
      REQUIRED_BOOTSTRAP_PROTECTED_CAPABILITIES.includes(
        capability as (typeof REQUIRED_BOOTSTRAP_PROTECTED_CAPABILITIES)[number],
      ),
    )
  );
}

function sortedUniqueSafePaths(
  value: unknown,
  allowEmpty: boolean,
): value is string[] {
  return (
    sortedUniqueStrings(value, allowEmpty) &&
    value.every((filePath) => safeClosurePath(filePath))
  );
}

function sortedUniqueStrings(
  value: unknown,
  allowEmpty: boolean,
): value is string[] {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.some((entry) => typeof entry !== 'string')
  ) {
    return false;
  }
  const sorted = [...new Set(value)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return canonicalJson(value) === canonicalJson(sorted);
}

function canonicalBase64Bytes(
  value: unknown,
  limit: number,
  allowEmpty: boolean,
): Buffer | null {
  if (
    typeof value !== 'string' ||
    value.length > Math.ceil((limit * 4) / 3) + 4
  ) {
    return null;
  }
  const bytes = Buffer.from(value, 'base64');
  return bytes.length <= limit &&
    (allowEmpty || bytes.length > 0) &&
    bytes.toString('base64') === value
    ? bytes
    : null;
}

function validBoundedSignature(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('\0') &&
    Buffer.byteLength(value) <= 64 * 1024
  );
}

function assertMaterializedPromotionArtifact(
  paths: BootstrapPaths,
  artifact: Record<string, unknown>,
  executableBase64: unknown,
): void {
  if (!validEngineArtifactV2(artifact)) throw supervisorNotTerminal();
  const bytes = canonicalBase64Bytes(
    executableBase64,
    MAX_EXECUTABLE_BYTES,
    false,
  );
  const executablePath = path.join(
    paths.artifacts,
    artifact.artifactId.slice('sha256:'.length),
    'engine',
  );
  const stats = fs.lstatSync(executablePath, { throwIfNoEntry: false });
  if (
    bytes === null ||
    rawDigest(bytes) !== artifact.executableDigest ||
    !stats?.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (stats.mode & 0o777) !== PRIVATE_EXECUTABLE_MODE ||
    stats.size !== bytes.length ||
    fs.realpathSync(executablePath) !== executablePath
  ) {
    throw supervisorNotTerminal();
  }
  const descriptor = fs.openSync(
    executablePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const opened = fs.fstatSync(descriptor);
    const observed = fs.readFileSync(descriptor);
    if (
      opened.dev !== stats.dev ||
      opened.ino !== stats.ino ||
      !observed.equals(bytes)
    ) {
      throw supervisorNotTerminal();
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertConfinedExecutable(
  paths: BootstrapPaths,
  supervisor: BootstrapControlPlaneSupervisorState,
): void {
  const active = supervisor.activeArtifact;
  const executablePath = active.executablePath;
  const expectedPath = path.join(
    paths.artifacts,
    active.artifactId.slice('sha256:'.length),
    'engine',
  );
  if (
    typeof executablePath !== 'string' ||
    !path.isAbsolute(executablePath) ||
    path.resolve(executablePath) !== executablePath ||
    executablePath !== expectedPath
  ) {
    throw supervisorCorrupt();
  }
  assertPrivateDirectory(paths.artifacts, 'CONTROL_PLANE_STATE_UNSAFE');
  assertPrivateDirectory(
    path.dirname(executablePath),
    'CONTROL_PLANE_STATE_UNSAFE',
  );
  const stats = fs.lstatSync(executablePath, { throwIfNoEntry: false });
  if (
    !stats?.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (stats.mode & 0o777) !== PRIVATE_EXECUTABLE_MODE ||
    stats.size < 1 ||
    stats.size > MAX_EXECUTABLE_BYTES ||
    fs.realpathSync(executablePath) !== executablePath
  ) {
    throw trustError(
      'CONTROL_PLANE_EXECUTABLE_UNSAFE',
      'Materialized control-plane executable is unsafe.',
      12,
    );
  }
  const descriptor = fs.openSync(
    executablePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const opened = fs.fstatSync(descriptor);
    const bytes = fs.readFileSync(descriptor);
    if (
      opened.dev !== stats.dev ||
      opened.ino !== stats.ino ||
      opened.size !== stats.size ||
      rawDigest(bytes) !== active.executableDigest
    ) {
      throw trustError(
        'CONTROL_PLANE_EXECUTABLE_DIGEST_MISMATCH',
        'Materialized control-plane executable digest changed.',
        13,
      );
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function builtInSupervisorExecutableSource(
  builtInClosureDigest: Sha256Digest,
  controlPlaneClosureDigest: Sha256Digest,
  entrypoint: string,
  bootstrapRuntimeFiles: VerifiedProtectedCapabilityManifest['bootstrapRuntimeFiles'],
): string {
  const runtimeDescriptors = bootstrapRuntimeFiles.map(
    ({ path: filePath, mode, digest }) => ({
      path: filePath,
      mode,
      digest,
    }),
  );
  if (
    !isDigest(builtInClosureDigest) ||
    !isDigest(controlPlaneClosureDigest) ||
    !safeClosurePath(entrypoint) ||
    runtimeDescriptors.length !== BUILT_IN_BOOTSTRAP_RUNTIME_PATHS.length ||
    runtimeDescriptors.some(
      (entry, index) =>
        entry.path !==
          BUILT_IN_BOOTSTRAP_RUNTIME_PATHS[index].slice(
            'packages/workflow-engine/'.length,
          ) ||
        (entry.mode !== '100644' && entry.mode !== '100755') ||
        !isDigest(entry.digest),
    ) ||
    /[\s\0\r\n]/.test(process.execPath)
  ) {
    throw builtInClosureMismatch();
  }
  return `#!${process.execPath}
'use strict';
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const BUILT_IN_CLOSURE_DIGEST = ${JSON.stringify(builtInClosureDigest)};
const CONTROL_PLANE_CLOSURE_DIGEST = ${JSON.stringify(controlPlaneClosureDigest)};
const ENTRYPOINT = ${JSON.stringify(entrypoint)};
const BOOTSTRAP_RUNTIME_FILES = ${JSON.stringify(runtimeDescriptors)};
const SOURCE_CHANGE_ID = 'repository-default-built-in';
const PROTOCOL_VERSION = ${BUILT_IN_PROTOCOL_VERSION};
const SESSION_SCHEMA = ${JSON.stringify(BUILT_IN_SESSION_SCHEMA)};
const POLICY_SCHEMA_VERSION = ${BUILT_IN_POLICY_SCHEMA_VERSION};
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_EXECUTABLE_MODE = 0o500;
const MAX_BYTES = ${MAX_CLOSURE_FILE_BYTES};

function digest(value) {
  return 'sha256:' + crypto.createHash('sha256').update(value).digest('hex');
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function assertDirectory(directory) {
  const stats = fs.lstatSync(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink() ||
      (stats.mode & 0o777) !== PRIVATE_DIRECTORY_MODE ||
      fs.realpathSync(directory) !== directory) throw new Error('unsafe directory');
}

function readPrivateFile(filePath, mode) {
  const stats = fs.lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 ||
      (stats.mode & 0o777) !== mode || stats.size < 1 || stats.size > MAX_BYTES ||
      fs.realpathSync(filePath) !== filePath) throw new Error('unsafe file');
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(descriptor);
    const bytes = fs.readFileSync(descriptor);
    if (opened.dev !== stats.dev || opened.ino !== stats.ino ||
        opened.size !== stats.size || bytes.length !== stats.size) throw new Error('changed file');
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

function safePath(value) {
  return typeof value === 'string' && value.length > 0 && value === value.normalize('NFC') &&
    !path.isAbsolute(value) && !value.includes('\\\\') && !/[*?[\\]{}]/.test(value) &&
    value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function listTypescriptFiles(packageRoot, directory) {
  assertDirectory(directory);
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('indirect closure');
    if (entry.isDirectory()) files.push(...listTypescriptFiles(packageRoot, absolute));
    else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(path.relative(packageRoot, absolute).split(path.sep).join('/'));
    }
  }
  return files.sort();
}

function listAllFiles(packageRoot, directory) {
  assertDirectory(directory);
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('indirect closure');
    if (entry.isDirectory()) files.push(...listAllFiles(packageRoot, absolute));
    else if (entry.isFile()) files.push(path.relative(packageRoot, absolute).split(path.sep).join('/'));
    else throw new Error('unsupported closure entry');
  }
  return files.sort();
}

function verifyClosure() {
  const artifactRoot = fs.realpathSync(__dirname);
  if (artifactRoot !== __dirname) throw new Error('indirect artifact');
  assertDirectory(artifactRoot);
  const closureRoot = path.join(artifactRoot, 'closure');
  assertDirectory(closureRoot);
  const manifestBytes = readPrivateFile(
    path.join(artifactRoot, 'built-in-engine-closure.json'),
    PRIVATE_FILE_MODE,
  );
  if (digest(manifestBytes) !== BUILT_IN_CLOSURE_DIGEST) throw new Error('manifest digest');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (JSON.stringify(manifest, null, 2) + '\\n' !== manifestBytes.toString('utf8') ||
      !exactKeys(manifest, ['entrypoint', 'files', 'kind', 'scope']) ||
      manifest.kind !== 'built-in-engine-closure-manifest.v1' ||
      manifest.entrypoint !== ENTRYPOINT ||
      manifest.scope !== 'package-json-and-all-src-typescript' ||
      !Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error('manifest shape');
  }
  const listed = [];
  for (const entry of manifest.files) {
    if (!exactKeys(entry, ['digest', 'mode', 'path']) || !safePath(entry.path) ||
        (entry.path !== 'package.json' && !(entry.path.startsWith('src/') && entry.path.endsWith('.ts'))) ||
        (entry.mode !== '100644' && entry.mode !== '100755') ||
        !/^sha256:[0-9a-f]{64}$/.test(entry.digest)) throw new Error('manifest entry');
    const target = path.join(closureRoot, ...entry.path.split('/'));
    if (path.resolve(target) !== target || !target.startsWith(closureRoot + path.sep)) throw new Error('escaped closure');
    if (digest(readPrivateFile(target, PRIVATE_FILE_MODE)) !== entry.digest) throw new Error('closure digest');
    listed.push(entry.path);
  }
  const sorted = [...new Set(listed)].sort();
  if (JSON.stringify(listed) !== JSON.stringify(sorted) ||
      !listed.includes('package.json') || !listed.includes(ENTRYPOINT) ||
      JSON.stringify(listTypescriptFiles(closureRoot, path.join(closureRoot, 'src'))) !==
        JSON.stringify(listed.filter((value) => value.startsWith('src/')))) {
    throw new Error('closure inventory');
  }
  for (const entry of BOOTSTRAP_RUNTIME_FILES) {
    if (!exactKeys(entry, ['digest', 'mode', 'path']) || !safePath(entry.path) ||
        !entry.path.startsWith('bootstrap/') ||
        (entry.mode !== '100644' && entry.mode !== '100755') ||
        !/^sha256:[0-9a-f]{64}$/.test(entry.digest)) throw new Error('bootstrap runtime entry');
    const target = path.join(closureRoot, ...entry.path.split('/'));
    if (digest(readPrivateFile(target, PRIVATE_FILE_MODE)) !== entry.digest) {
      throw new Error('bootstrap runtime digest');
    }
  }
  const completeInventory = [...listed, ...BOOTSTRAP_RUNTIME_FILES.map((entry) => entry.path)].sort();
  if (JSON.stringify(listAllFiles(closureRoot, closureRoot)) !== JSON.stringify(completeInventory)) {
    throw new Error('complete closure inventory');
  }
  const selfBytes = readPrivateFile(__filename, PRIVATE_EXECUTABLE_MODE);
  const executableDigest = digest(selfBytes);
  const selfTest = {
    kind: 'control-plane-self-test.v1',
    healthy: true,
    closureDigest: CONTROL_PLANE_CLOSURE_DIGEST,
  };
  const artifactPayload = {
    kind: 'engine-artifact.v1',
    sourceChangeId: SOURCE_CHANGE_ID,
    sourceDigest: BUILT_IN_CLOSURE_DIGEST,
    executableDigest,
    protocolVersion: PROTOCOL_VERSION,
    canReadSessionSchemas: [SESSION_SCHEMA],
    writesSessionSchema: SESSION_SCHEMA,
    policySchemaVersion: POLICY_SCHEMA_VERSION,
    smokeReportDigest: digest(canonical(selfTest)),
  };
  const artifact = { ...artifactPayload, artifactId: digest(canonical(artifactPayload)) };
  const artifactBytes = readPrivateFile(
    path.join(artifactRoot, 'engine-artifact.json'),
    PRIVATE_FILE_MODE,
  );
  const observedArtifact = JSON.parse(artifactBytes.toString('utf8'));
  if (canonical(observedArtifact) + '\\n' !== artifactBytes.toString('utf8') ||
      canonical(observedArtifact) !== canonical(artifact)) throw new Error('artifact metadata');
  return { closureRoot, selfTest };
}

try {
  const verified = verifyClosure();
  if (process.argv.length === 3 && process.argv[2] === '--control-plane-restart-probe') {
    process.stdout.write(JSON.stringify({
      kind: 'control-plane-restart.v1',
      ready: true,
      closureDigest: CONTROL_PLANE_CLOSURE_DIGEST,
    }) + '\\n');
    process.exit(0);
  }
  if (process.argv.length === 3 && process.argv[2] === '--control-plane-self-test') {
    process.stdout.write(JSON.stringify(verified.selfTest) + '\\n');
    process.exit(0);
  }
  const entrypointPath = path.join(verified.closureRoot, ...ENTRYPOINT.split('/'));
  const result = childProcess.spawnSync(
    process.execPath,
    ['--experimental-strip-types', entrypointPath, ...process.argv.slice(2)],
    { cwd: process.cwd(), env: process.env, stdio: 'inherit', windowsHide: true },
  );
  if (result.error !== undefined) throw result.error;
  if (result.signal !== null) {
    process.kill(process.pid, result.signal);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
} catch (error) {
  process.stderr.write(JSON.stringify({
    kind: 'control-plane-bootstrap-artifact-error.v1',
    code: 'CONTROL_PLANE_BOOTSTRAP_ARTIFACT_MISMATCH',
    message: error instanceof Error ? error.message : String(error),
  }) + '\\n');
  process.exit(13);
}
`;
}

function runRestartProbe(
  paths: BootstrapPaths,
  supervisor: BootstrapControlPlaneSupervisorState,
): void {
  assertConfinedExecutable(paths, supervisor);
  const executablePath = supervisor.activeArtifact.executablePath;
  const cwd = path.dirname(executablePath);
  const result = childProcess.spawnSync(
    executablePath,
    ['--control-plane-restart-probe'],
    {
      cwd,
      env: {
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        LANG: 'C',
        LC_ALL: 'C',
        TMPDIR: cwd,
      },
      encoding: 'utf8',
      timeout: PROCESS_TIMEOUT_MS,
      maxBuffer: PROCESS_MAX_BUFFER_BYTES,
      windowsHide: true,
    },
  );
  if (
    result.error !== undefined ||
    result.signal !== null ||
    result.status !== 0 ||
    typeof result.stdout !== 'string' ||
    Buffer.byteLength(result.stdout) > PROCESS_MAX_BUFFER_BYTES
  ) {
    throw processVerificationFailed(
      'Control-plane restart probe did not exit cleanly.',
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(result.stdout.trim());
  } catch {
    throw processVerificationFailed(
      'Control-plane restart probe returned invalid JSON.',
    );
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['closureDigest', 'kind', 'ready']) ||
    value.kind !== 'control-plane-restart.v1' ||
    value.ready !== true ||
    value.closureDigest !== supervisor.activeArtifact.closureDigest
  ) {
    throw processVerificationFailed(
      'Control-plane restart probe response is invalid.',
    );
  }
}

function verifyClosureManifest(value: unknown): BuiltInClosureManifest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['entrypoint', 'files', 'kind', 'scope']) ||
    value.kind !== 'built-in-engine-closure-manifest.v1' ||
    value.entrypoint !== 'src/cli.ts' ||
    value.scope !== 'package-json-and-all-src-typescript' ||
    !Array.isArray(value.files) ||
    value.files.length === 0
  ) {
    throw builtInClosureMismatch();
  }
  const files = value.files;
  for (const entry of files) {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ['digest', 'mode', 'path']) ||
      !safeClosurePath(entry.path) ||
      (entry.path !== 'package.json' &&
        !(entry.path.startsWith('src/') && entry.path.endsWith('.ts'))) ||
      (entry.mode !== '100644' && entry.mode !== '100755') ||
      !isDigest(entry.digest)
    ) {
      throw builtInClosureMismatch();
    }
  }
  const paths = files.map((entry) => String(entry.path));
  const sorted = [...new Set(paths)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  if (
    canonicalJson(paths) !== canonicalJson(sorted) ||
    !paths.includes(String(value.entrypoint)) ||
    !paths.includes('package.json')
  ) {
    throw builtInClosureMismatch();
  }
  return value as unknown as BuiltInClosureManifest;
}

function listPackageTypescriptFiles(
  packageRoot: string,
  directory: string,
): string[] {
  const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (
    !stats?.isDirectory() ||
    stats.isSymbolicLink() ||
    fs.realpathSync(directory) !== directory
  ) {
    throw builtInClosureMismatch();
  }
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw builtInClosureMismatch();
    if (entry.isDirectory()) {
      files.push(...listPackageTypescriptFiles(packageRoot, absolute));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      const relative = path.relative(packageRoot, absolute);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw builtInClosureMismatch();
      }
      files.push(relative.split(path.sep).join('/'));
    }
  }
  return files.sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

function readClosureFile(filePath: string, expectedMode: number): Buffer {
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (
    !stats?.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (stats.mode & 0o777) !== expectedMode ||
    stats.size < 1 ||
    stats.size > MAX_CLOSURE_FILE_BYTES ||
    fs.realpathSync(filePath) !== filePath
  ) {
    throw builtInClosureMismatch();
  }
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const opened = fs.fstatSync(descriptor);
    const bytes = fs.readFileSync(descriptor);
    if (
      opened.dev !== stats.dev ||
      opened.ino !== stats.ino ||
      opened.size !== stats.size ||
      bytes.length !== stats.size
    ) {
      throw builtInClosureMismatch();
    }
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

function readCanonicalPrivateRecord(
  filePath: string,
  corrupt: () => Error = supervisorCorrupt,
  maxBytes = MAX_STATE_BYTES,
): unknown {
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (
    !stats?.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (stats.mode & 0o777) !== PRIVATE_FILE_MODE ||
    stats.size < 1 ||
    stats.size > maxBytes ||
    fs.realpathSync(filePath) !== filePath
  ) {
    throw corrupt();
  }
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const opened = fs.fstatSync(descriptor);
    const raw = fs.readFileSync(descriptor, 'utf8');
    if (
      opened.dev !== stats.dev ||
      opened.ino !== stats.ino ||
      opened.size !== stats.size ||
      Buffer.byteLength(raw) !== stats.size
    ) {
      throw corrupt();
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw corrupt();
    }
    if (`${canonicalJson(value)}\n` !== raw) throw corrupt();
    return value;
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertRecoveryDirectory(
  directory: string,
  requirePrivateMode: boolean,
): void {
  const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
  const currentUid = process.getuid?.();
  if (
    !stats?.isDirectory() ||
    stats.isSymbolicLink() ||
    (requirePrivateMode && (stats.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) ||
    (currentUid !== undefined && stats.uid !== currentUid) ||
    fs.realpathSync(directory) !== directory
  ) {
    throw recoveryQuarantineStateCorrupt();
  }
}

function recoveryDirectoryEntries(directory: string): fs.Dirent[] {
  assertRecoveryDirectory(directory, true);
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  if (
    entries.some(
      (entry) =>
        entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile()),
    )
  ) {
    throw recoveryQuarantineStateCorrupt();
  }
  return entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
}

function assertRecoveryAuthorityInventory(directory: string): void {
  const entries = recoveryDirectoryEntries(directory);
  if (
    entries.length !== 1 ||
    entries[0]?.name !== 'descriptor.json' ||
    !entries[0].isFile()
  ) {
    throw recoveryQuarantineStateCorrupt();
  }
  readRecoveryDigestRecord(
    path.join(directory, 'descriptor.json'),
    'harness-recovery-authority.v1',
    'descriptorDigest',
    [
      'allowedDomains',
      'auditLedger',
      'createdAt',
      'descriptorDigest',
      'generation',
      'kind',
      'repositoryIdentity',
      'repositoryIdentityDigest',
      'sealedRuntime',
      'signer',
    ],
  );
}

function readRecoveryQuarantineInventory(
  directory: string,
): BootstrapRecoveryQuarantineMarker | null {
  const entries = recoveryDirectoryEntries(directory);
  const allowed = new Set(['active-marker.json', 'grants', 'release-claims']);
  if (
    entries.length === 0 ||
    entries.some((entry) => !allowed.has(entry.name))
  ) {
    throw recoveryQuarantineStateCorrupt();
  }
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const grantsEntry = byName.get('grants');
  const claimsEntry = byName.get('release-claims');
  if (
    !grantsEntry?.isDirectory() ||
    !claimsEntry?.isDirectory() ||
    (byName.has('active-marker.json') &&
      !byName.get('active-marker.json')?.isFile())
  ) {
    throw recoveryQuarantineStateCorrupt();
  }
  const histories = readRecoveryGrantHistories(path.join(directory, 'grants'));
  readRecoveryReleaseClaims(path.join(directory, 'release-claims'));
  if (!byName.has('active-marker.json')) return null;
  const marker = readRecoveryQuarantineMarkerRecord(
    path.join(directory, 'active-marker.json'),
  );
  const enter = histories.get(marker.enterGrantId);
  if (
    enter === undefined ||
    enter.operation !== 'enter-quarantine' ||
    enter.markerDigest !== marker.markerDigest
  ) {
    throw recoveryQuarantineStateCorrupt();
  }
  return marker;
}

function readRecoveryGrantHistories(
  directory: string,
): Map<string, { operation: string; markerDigest: string }> {
  const histories = new Map<
    string,
    { operation: string; markerDigest: string }
  >();
  const directories = recoveryDirectoryEntries(directory);
  if (directories.length === 0) throw recoveryQuarantineStateCorrupt();
  for (const entry of directories) {
    if (
      !entry.isDirectory() ||
      !RECOVERY_QUARANTINE_HISTORY_DIRECTORY.test(entry.name)
    ) {
      throw recoveryQuarantineStateCorrupt();
    }
    const grantDirectory = path.join(directory, entry.name);
    const files = recoveryDirectoryEntries(grantDirectory);
    const expectedFiles = [
      'audit-ack.json',
      'audit.json',
      'receipt.json',
      'reservation.json',
      'terminal.json',
    ];
    if (
      files.length !== expectedFiles.length ||
      files.some(
        (file, index) => !file.isFile() || file.name !== expectedFiles[index],
      )
    ) {
      throw recoveryQuarantineStateCorrupt();
    }
    const reservation = readRecoveryDigestRecord(
      path.join(grantDirectory, 'reservation.json'),
      'recovery-quarantine-reservation.v1',
      'reservationDigest',
      [
        'envelope',
        'envelopeDigest',
        'grantId',
        'kind',
        'operation',
        'reservationDigest',
        'reservedAt',
      ],
    );
    const receipt = readRecoveryDigestRecord(
      path.join(grantDirectory, 'receipt.json'),
      'recovery-quarantine-receipt.v1',
      'receiptDigest',
      [
        'authorityDescriptorDigest',
        'authorityGeneration',
        'completedAt',
        'externalAuditRoot',
        'grantId',
        'kind',
        'markerDigest',
        'operation',
        'receiptDigest',
        'recoveryRuntimeDigest',
        'repositoryId',
        'result',
      ],
    );
    const terminal = readRecoveryDigestRecord(
      path.join(grantDirectory, 'terminal.json'),
      'recovery-quarantine-terminal.v1',
      'terminalDigest',
      [
        'consumedAt',
        'envelopeDigest',
        'grantId',
        'kind',
        'markerDigest',
        'operation',
        'receiptDigest',
        'state',
        'terminalDigest',
      ],
    );
    const audit = readRecoveryDigestRecord(
      path.join(grantDirectory, 'audit.json'),
      'recovery-quarantine-audit.v1',
      'recordDigest',
      [
        'authorityDescriptorDigest',
        'authorityGeneration',
        'enterEnvelopeDigest',
        'envelopeDigest',
        'event',
        'externalAuditRoot',
        'grantId',
        'humanSigner',
        'kind',
        'markerDigest',
        'operation',
        'receiptDigest',
        'recordDigest',
        'recordId',
        'recordedAt',
        'recoveryRuntimeDigest',
        'repositoryId',
        'signerFingerprint',
        'terminalDigest',
      ].filter((key) => key !== 'enterEnvelopeDigest'),
    );
    const acknowledgement = readRecoveryDigestRecord(
      path.join(grantDirectory, 'audit-ack.json'),
      'recovery-quarantine-audit-ack.v1',
      'acknowledgementDigest',
      [
        'acknowledgedAt',
        'acknowledgementDigest',
        'grantId',
        'kind',
        'recordDigest',
        'recordId',
      ],
    );
    const grantId = reservation.grantId;
    const operation = reservation.operation;
    const markerDigest = receipt.markerDigest;
    if (
      typeof grantId !== 'string' ||
      !RECOVERY_QUARANTINE_GRANT_ID.test(grantId) ||
      sha256Hex(grantId) !== entry.name ||
      (operation !== 'enter-quarantine' &&
        operation !== 'release-quarantine') ||
      !isDigest(markerDigest) ||
      receipt.grantId !== grantId ||
      terminal.grantId !== grantId ||
      audit.grantId !== grantId ||
      acknowledgement.grantId !== grantId ||
      receipt.operation !== operation ||
      terminal.operation !== operation ||
      audit.operation !== operation ||
      terminal.state !== 'consumed' ||
      terminal.receiptDigest !== receipt.receiptDigest ||
      terminal.markerDigest !== markerDigest ||
      audit.receiptDigest !== receipt.receiptDigest ||
      audit.terminalDigest !== terminal.terminalDigest ||
      audit.markerDigest !== markerDigest ||
      acknowledgement.recordId !== audit.recordId ||
      acknowledgement.recordDigest !== audit.recordDigest ||
      histories.has(grantId)
    ) {
      throw recoveryQuarantineStateCorrupt();
    }
    histories.set(grantId, { operation, markerDigest });
  }
  return histories;
}

function readRecoveryReleaseClaims(directory: string): void {
  for (const entry of recoveryDirectoryEntries(directory)) {
    if (!entry.isFile() || !RECOVERY_QUARANTINE_CLAIM_FILE.test(entry.name)) {
      throw recoveryQuarantineStateCorrupt();
    }
    const claim = readRecoveryDigestRecord(
      path.join(directory, entry.name),
      'recovery-quarantine-release-claim.v1',
      'claimDigest',
      [
        'claimDigest',
        'claimedAt',
        'kind',
        'markerDigest',
        'releaseEnvelopeDigest',
        'releaseGrantId',
      ],
    );
    if (
      !isDigest(claim.markerDigest) ||
      `${claim.markerDigest.slice('sha256:'.length)}.json` !== entry.name ||
      typeof claim.releaseGrantId !== 'string' ||
      !RECOVERY_QUARANTINE_GRANT_ID.test(claim.releaseGrantId)
    ) {
      throw recoveryQuarantineStateCorrupt();
    }
  }
}

function readRecoveryQuarantineMarkerRecord(
  filePath: string,
): BootstrapRecoveryQuarantineMarker {
  const value = readRecoveryDigestRecord(
    filePath,
    'recovery-quarantine-marker.v1',
    'markerDigest',
    [
      'authorityDescriptorDigest',
      'authorityGeneration',
      'enterEnvelopeDigest',
      'enterGrantId',
      'enteredAt',
      'externalAuditRoot',
      'kind',
      'markerDigest',
      'recoveryRuntimeDigest',
      'repositoryId',
    ],
  );
  if (
    !isNonEmptyTrimmed(value.repositoryId) ||
    !isDigest(value.authorityDescriptorDigest) ||
    !Number.isSafeInteger(value.authorityGeneration) ||
    Number(value.authorityGeneration) < 1 ||
    !isDigest(value.recoveryRuntimeDigest) ||
    typeof value.externalAuditRoot !== 'string' ||
    !path.isAbsolute(value.externalAuditRoot) ||
    path.resolve(value.externalAuditRoot) !== value.externalAuditRoot ||
    typeof value.enterGrantId !== 'string' ||
    !RECOVERY_QUARANTINE_GRANT_ID.test(value.enterGrantId) ||
    !isDigest(value.enterEnvelopeDigest) ||
    !isCanonicalIso(value.enteredAt) ||
    !isDigest(value.markerDigest)
  ) {
    throw recoveryQuarantineStateCorrupt();
  }
  return value as unknown as BootstrapRecoveryQuarantineMarker;
}

function readRecoveryDigestRecord(
  filePath: string,
  expectedKind: string,
  digestField: string,
  exactKeys: readonly string[],
): Record<string, unknown> {
  const before = fs.lstatSync(filePath, { throwIfNoEntry: false });
  const currentUid = process.getuid?.();
  if (
    !before?.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    (before.mode & 0o777) !== PRIVATE_FILE_MODE ||
    (currentUid !== undefined && before.uid !== currentUid) ||
    fs.realpathSync(filePath) !== filePath
  ) {
    throw recoveryQuarantineStateCorrupt();
  }
  const value = readCanonicalPrivateRecord(
    filePath,
    recoveryQuarantineStateCorrupt,
  );
  const after = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (
    !after ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs ||
    !isRecord(value) ||
    !hasExactKeys(value, [...exactKeys]) ||
    value.kind !== expectedKind ||
    !isDigest(value[digestField])
  ) {
    throw recoveryQuarantineStateCorrupt();
  }
  const payload = { ...value };
  delete payload[digestField];
  if (canonicalDigest(payload) !== value[digestField]) {
    throw recoveryQuarantineStateCorrupt();
  }
  return value;
}

function sha256Hex(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function assertPrivateDirectory(directory: string, code: string): void {
  const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (
    !stats?.isDirectory() ||
    stats.isSymbolicLink() ||
    (stats.mode & 0o777) !== PRIVATE_DIRECTORY_MODE ||
    fs.realpathSync(directory) !== directory
  ) {
    throw trustError(
      code,
      'Control-plane state directory is missing, indirect, or unsafe.',
      12,
    );
  }
}

function assertExactPackageRoot(packageRoot: string): void {
  const stats = fs.lstatSync(packageRoot, { throwIfNoEntry: false });
  if (
    typeof packageRoot !== 'string' ||
    !path.isAbsolute(packageRoot) ||
    path.resolve(packageRoot) !== packageRoot ||
    !stats?.isDirectory() ||
    stats.isSymbolicLink() ||
    fs.realpathSync(packageRoot) !== packageRoot
  ) {
    throw builtInClosureMismatch();
  }
}

function verifyJournalDigest(transaction: Record<string, unknown>): boolean {
  if (!isDigest(transaction.journalDigest)) return false;
  const { journalDigest, ...payload } = transaction;
  return canonicalDigest(payload) === journalDigest;
}

function verifyRecordDigest(record: Record<string, unknown>): boolean {
  if (!isDigest(record.recordDigest)) return false;
  const { recordDigest, ...payload } = record;
  return canonicalDigest(payload) === recordDigest;
}

function validTerminalHistory(state: unknown, history: unknown): boolean {
  if (state !== 'FINALIZED' && state !== 'ROLLED_BACK') return false;
  if (!Array.isArray(history)) return false;
  const expected = TERMINAL_HISTORIES[state];
  if (history.length !== expected.length) return false;
  let previousTime = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < history.length; index += 1) {
    const entry = history[index];
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ['at', 'state']) ||
      entry.state !== expected[index] ||
      !isCanonicalIso(entry.at)
    ) {
      return false;
    }
    const currentTime = Date.parse(entry.at);
    if (currentTime < previousTime) return false;
    previousTime = currentTime;
  }
  return true;
}

function validTransition(
  value: BootstrapControlPlaneSupervisorState['transition'],
): boolean {
  return (
    value === null ||
    (isRecord(value) &&
      hasExactKeys(value, ['grantId', 'phase', 'txId']) &&
      isNonEmptyTrimmed(value.grantId) &&
      isNonEmptyTrimmed(value.txId) &&
      (value.phase === 'candidate-selected' ||
        value.phase === 'rollback-restored'))
  );
}

function identityFileName(kind: string, identity: string): string {
  return crypto
    .createHash('sha256')
    .update(`${kind}\0${identity}`)
    .digest('hex');
}

function parentChangeIdFromBranch(branchRef: string | null): string | null {
  const prefix = 'refs/heads/work/';
  if (branchRef === null || !branchRef.startsWith(prefix)) return null;
  const parentChangeId = branchRef.slice(prefix.length);
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(parentChangeId)
    ? parentChangeId
    : null;
}

function assertExactWorktreeRoot(worktreeRoot: string): void {
  const stats = fs.lstatSync(worktreeRoot, { throwIfNoEntry: false });
  if (
    typeof worktreeRoot !== 'string' ||
    !path.isAbsolute(worktreeRoot) ||
    path.resolve(worktreeRoot) !== worktreeRoot ||
    !stats?.isDirectory() ||
    stats.isSymbolicLink() ||
    fs.realpathSync(worktreeRoot) !== worktreeRoot
  ) {
    throw localBindingMismatch();
  }
}

function safeClosurePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value === value.normalize('NFC') &&
    !path.isAbsolute(value) &&
    !value.includes('\\') &&
    !/[*?[\]{}]/.test(value) &&
    value
      .split('/')
      .every((part) => part.length > 0 && part !== '.' && part !== '..')
  );
}

function isNonEmptyTrimmed(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.trim() === value
  );
}

function isCanonicalIso(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function isDigest(value: unknown): value is Sha256Digest {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

function rawDigest(value: string | Buffer): Sha256Digest {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function canonicalDigest(value: unknown): Sha256Digest {
  return rawDigest(canonicalJson(value));
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort())
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
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

function bootstrapRepositoryIdentityInvalid(): Error & {
  code: string;
  exitCode: number;
} {
  return trustError(
    'CONTROL_PLANE_BOOTSTRAP_REPOSITORY_IDENTITY_INVALID',
    'Initial supervisor repository identity could not be verified from clean Git inputs.',
    11,
  );
}

function bootstrapPackageRootInvalid(): Error & {
  code: string;
  exitCode: number;
} {
  return trustError(
    'CONTROL_PLANE_BOOTSTRAP_PACKAGE_ROOT_INVALID',
    'Initial supervisor package root is not the exact tracked workflow-engine package in this worktree.',
    13,
  );
}

function bootstrapBaseMismatch(): Error & {
  code: string;
  exitCode: number;
} {
  return trustError(
    'CONTROL_PLANE_BOOTSTRAP_BASE_MISMATCH',
    'Initial supervisor bootstrap requires HEAD on an exact configured protected base branch.',
    14,
  );
}

function bootstrapRemoteBaseMismatch(): Error & {
  code: string;
  exitCode: number;
} {
  return trustError(
    'CONTROL_PLANE_BOOTSTRAP_REMOTE_BASE_MISMATCH',
    'Initial supervisor HEAD is not the exact locally tracked origin base commit.',
    14,
  );
}

function bootstrapProvenanceChanged(): Error & {
  code: string;
  exitCode: number;
} {
  return trustError(
    'CONTROL_PLANE_BOOTSTRAP_PROVENANCE_CHANGED',
    'Initial supervisor repository HEAD, tree, branch, or identity changed during sealed bootstrap.',
    14,
  );
}

function initialBootstrapJournalCorrupt(): Error & {
  code: string;
  exitCode: number;
} {
  return trustError(
    'CONTROL_PLANE_BOOTSTRAP_JOURNAL_CORRUPT',
    'Initial supervisor bootstrap journal is partial, malformed, indirect, or inconsistent.',
    13,
  );
}

function protectedCapabilityManifestInvalid(): Error & {
  code: string;
  exitCode: number;
} {
  return trustError(
    'CONTROL_PLANE_BOOTSTRAP_PROTECTED_MANIFEST_INVALID',
    'Tracked protected-capability manifest failed sealed bootstrap validation.',
    13,
  );
}

function bootstrapStateNotEmpty(): Error & {
  code: string;
  exitCode: number;
} {
  return trustError(
    'CONTROL_PLANE_BOOTSTRAP_STATE_NOT_EMPTY',
    'Initial global control-plane namespace contains unknown or non-replayable state.',
    14,
  );
}

function supervisorAlreadyInitialized(): Error & {
  code: string;
  exitCode: number;
} {
  return trustError(
    'CONTROL_PLANE_SUPERVISOR_ALREADY_INITIALIZED',
    'Control-plane supervisor is already initialized with different exact state.',
    14,
  );
}

function bootstrapArtifactMismatch(): Error & {
  code: string;
  exitCode: number;
} {
  return trustError(
    'CONTROL_PLANE_BOOTSTRAP_ARTIFACT_MISMATCH',
    'Initial built-in control-plane artifact is partial, changed, or not exact.',
    13,
  );
}

function supervisorCorrupt(): Error & { code: string; exitCode: number } {
  return trustError(
    'CONTROL_PLANE_SUPERVISOR_CORRUPT',
    'Control-plane supervisor state failed integrity verification.',
    13,
  );
}

function localBindingCorrupt(): Error & { code: string; exitCode: number } {
  return trustError(
    'WORKFLOW_LOCAL_ADOPTION_BINDING_CORRUPT',
    'Local engine binding failed canonical integrity verification.',
    13,
  );
}

function localBindingMismatch(): Error & { code: string; exitCode: number } {
  return trustError(
    'WORKFLOW_LOCAL_ADOPTION_BINDING_MISMATCH',
    'Local engine binding disagrees with its exact worktree or adoption journal.',
    13,
  );
}

function localJournalCorrupt(): Error & { code: string; exitCode: number } {
  return trustError(
    'WORKFLOW_LOCAL_ADOPTION_JOURNAL_CORRUPT',
    'Persisted local adoption journal failed canonical integrity verification.',
    13,
  );
}

function interventionFenceCorrupt(): Error & {
  code: string;
  exitCode: number;
} {
  return trustError(
    'WORKFLOW_PARENT_INTERVENTION_FENCE_CORRUPT',
    'Parent intervention fence failed canonical integrity verification.',
    13,
  );
}

function supervisorNotTerminal(): Error & {
  code: string;
  exitCode: number;
} {
  return trustError(
    'CONTROL_PLANE_SUPERVISOR_NOT_TERMINAL',
    'Control-plane supervisor does not select a terminal promotion result.',
    14,
  );
}

function processVerificationFailed(
  message: string,
): Error & { code: string; exitCode: number } {
  return trustError('CONTROL_PLANE_PROCESS_VERIFICATION_FAILED', message, 13);
}

function builtInClosureMismatch(): Error & {
  code: string;
  exitCode: number;
} {
  return trustError(
    'WORKFLOW_BUILT_IN_ENGINE_CLOSURE_MISMATCH',
    'Built-in E1 closure is missing, indirect, stale, or has changed bytes.',
    13,
  );
}

function recoveryQuarantineStateCorrupt(): Error & {
  code: string;
  exitCode: number;
} {
  return trustError(
    'WORKFLOW_RECOVERY_QUARANTINE_STATE_CORRUPT',
    'Recovery Quarantine state is unknown, incomplete, indirect, or failed canonical integrity verification.',
    13,
  );
}

function trustError(
  code: string,
  message: string,
  exitCode: number,
): Error & { code: string; exitCode: number } {
  return Object.assign(new Error(message), { code, exitCode });
}
