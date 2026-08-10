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
const PROCESS_TIMEOUT_MS = 10_000;
const PROCESS_MAX_BUFFER_BYTES = 1024 * 1024;

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

export interface BootstrapWorktreeIdentity {
  worktreeRoot: string;
  branchRef: string | null;
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

interface BootstrapPaths {
  root: string;
  supervisor: string;
  bundles: string;
  artifacts: string;
  controlUpdates: string;
  adoptions: string;
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
  state: BootstrapAdoptionState;
  history: Array<{ state: BootstrapAdoptionState; at: string }>;
  journalDigest: Sha256Digest;
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
 * Resolve the exact active engine using only bootstrap-owned verification.
 * Null is allowed only for a repository that has never materialized a
 * supervisor artifact or promotion bundle.
 */
export function resolveControlPlaneEngineSelection(
  storageRoot: string,
): BootstrapControlPlaneSupervisorState | null {
  const paths = bootstrapPaths(storageRoot);
  const supervisor = fs.lstatSync(paths.supervisor, { throwIfNoEntry: false });
  if (supervisor === undefined) {
    if (
      fs.lstatSync(paths.artifacts, { throwIfNoEntry: false }) !== undefined ||
      fs.lstatSync(paths.bundles, { throwIfNoEntry: false }) !== undefined
    ) {
      throw supervisorCorrupt();
    }
    return null;
  }

  assertPrivateDirectory(paths.root, 'CONTROL_PLANE_STATE_UNSAFE');
  const state = readSupervisor(paths);
  assertTerminalSelection(paths, state);
  runRestartProbe(paths, state);
  return deepFreeze(structuredClone(state));
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
  const journal = readLocalAdoptionJournal(adoptionPath, binding.txId);
  assertLocalBindingJournalIdentity(paths, binding, journal);

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

  for (const entry of manifest.files) {
    const absolute = path.join(packageRoot, ...entry.path.split('/'));
    const expectedMode = entry.mode === '100755' ? 0o755 : 0o644;
    const bytes = readClosureFile(absolute, expectedMode);
    if (rawDigest(bytes) !== entry.digest) throw builtInClosureMismatch();
  }
  return path.join(packageRoot, ...manifest.entrypoint.split('/'));
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
    bundles: path.join(storageRoot, 'control-plane-promotion-bundles'),
    artifacts: path.join(storageRoot, 'control-plane-artifacts'),
    controlUpdates: path.join(storageRoot, 'control-updates'),
    adoptions: path.join(storageRoot, 'adoptions'),
    localSessions: path.join(storageRoot, 'local-parent-sessions'),
    localArtifacts: path.join(storageRoot, 'local-engine-artifacts'),
  };
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
): BootstrapAdoptionJournal {
  const value = readCanonicalPrivateRecord(filePath, localJournalCorrupt);
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'createdAt',
      'effectsPerformed',
      'grantEnvelopeDigest',
      'journal',
      'kind',
      'maintenanceGrantEnvelope',
      'observations',
      'recordDigest',
      'updatedAt',
    ]) ||
    value.kind !== 'persisted-engine-adoption.v1' ||
    value.effectsPerformed !== false ||
    !verifyRecordDigest(value) ||
    !isDigest(value.grantEnvelopeDigest) ||
    canonicalDigest(value.maintenanceGrantEnvelope) !==
      value.grantEnvelopeDigest ||
    !Array.isArray(value.observations) ||
    !isCanonicalIso(value.createdAt) ||
    !isCanonicalIso(value.updatedAt) ||
    Date.parse(value.updatedAt) < Date.parse(value.createdAt) ||
    !isRecord(value.journal)
  ) {
    throw localJournalCorrupt();
  }
  const journal = value.journal as unknown as BootstrapAdoptionJournal;
  if (
    !hasExactKeys(value.journal, [
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
    ]) ||
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
    !verifyJournalDigest(value.journal) ||
    !validAdoptionHistory(journal.state, journal.history)
  ) {
    throw localJournalCorrupt();
  }
  return journal;
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
  if (transition === null) return;
  assertPrivateDirectory(paths.controlUpdates, 'CONTROL_PLANE_STATE_UNSAFE');
  const recordPath = path.join(
    paths.controlUpdates,
    `${identityFileName('control-update', transition.grantId)}.json`,
  );
  const value = readCanonicalPrivateRecord(recordPath);
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
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
    value.kind !== 'persisted-control-plane-update.v1' ||
    value.grantState !== 'consumed' ||
    value.effectsPerformed !== false ||
    !verifyRecordDigest(value) ||
    !isCanonicalIso(value.createdAt) ||
    !isCanonicalIso(value.updatedAt) ||
    Date.parse(value.updatedAt) < Date.parse(value.createdAt) ||
    !Array.isArray(value.changes) ||
    !Array.isArray(value.observations) ||
    !isRecord(value.envelope) ||
    !isRecord(value.envelope.payload) ||
    value.envelope.payload.grantId !== transition.grantId ||
    value.envelope.payload.repositoryId !== supervisor.repositoryId ||
    !isRecord(value.beforeManifest) ||
    !isRecord(value.afterManifest) ||
    !isRecord(value.transaction)
  ) {
    throw supervisorNotTerminal();
  }
  const transaction = value.transaction;
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
    transaction.grantId !== transition.grantId ||
    transaction.txId !== transition.txId ||
    !isNonEmptyTrimmed(transaction.grantId) ||
    !isNonEmptyTrimmed(transaction.txId) ||
    !isDigest(transaction.candidateDigest) ||
    !isDigest(transaction.beforeClosureDigest) ||
    !isDigest(transaction.afterClosureDigest) ||
    !isDigest(transaction.recoveryBundleDigest) ||
    !Number.isSafeInteger(transaction.updaterVersion) ||
    Number(transaction.updaterVersion) < 1 ||
    !verifyJournalDigest(transaction) ||
    !validTerminalHistory(transaction.state, transaction.history) ||
    value.beforeManifest.manifestDigest !== transaction.beforeClosureDigest ||
    value.afterManifest.manifestDigest !== transaction.afterClosureDigest ||
    value.envelope.payload.candidateDigest !== transaction.candidateDigest ||
    value.envelope.payload.beforeClosureDigest !==
      transaction.beforeClosureDigest ||
    value.envelope.payload.afterClosureDigest !==
      transaction.afterClosureDigest ||
    value.envelope.payload.updaterVersion !== transaction.updaterVersion
  ) {
    throw supervisorNotTerminal();
  }

  const candidateSelected =
    transition.phase === 'candidate-selected' &&
    transaction.state === 'FINALIZED' &&
    supervisor.activeArtifact.closureDigest === transaction.afterClosureDigest;
  const rollbackRestored =
    transition.phase === 'rollback-restored' &&
    transaction.state === 'ROLLED_BACK' &&
    supervisor.activeArtifact.closureDigest === transaction.beforeClosureDigest;
  if (!candidateSelected && !rollbackRestored) {
    throw supervisorNotTerminal();
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
  return files.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
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
): unknown {
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (
    !stats?.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (stats.mode & 0o777) !== PRIVATE_FILE_MODE ||
    stats.size < 1 ||
    stats.size > MAX_STATE_BYTES ||
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

function trustError(
  code: string,
  message: string,
  exitCode: number,
): Error & { code: string; exitCode: number } {
  return Object.assign(new Error(message), { code, exitCode });
}
