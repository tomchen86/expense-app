import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  recoveryAuthorityDescriptorDigest,
  recoveryAuthorityRepositoryIdentityDigest,
  type RecoveryAuthorityDescriptorPayloadV1,
  type RecoveryAuthorityDescriptorV1,
  type RecoveryAuthorityExpectations,
} from '../src/recovery-authority.ts';
import {
  RECOVERY_QUARANTINE_ENTER_NAMESPACE,
  RECOVERY_QUARANTINE_RELEASE_NAMESPACE,
  createRecoveryQuarantineEnterGrantPayload,
  createRecoveryQuarantineReleaseGrantPayload,
  executeRecoveryQuarantineEnter,
  executeRecoveryQuarantineRelease,
  type RecoveryQuarantineAuditRecord,
  type RecoveryQuarantineEnvelope,
  type RecoveryQuarantineGrantPayload,
} from '../src/recovery-quarantine.ts';
import {
  controlPlaneCandidateDigest,
  controlPlaneIndependentReviewAttestationDigest,
  createEngineArtifact,
  createProtectedCapabilityManifest,
  protectedCapabilityClosureDigest,
  REQUIRED_PROTECTED_CAPABILITIES,
  type ControlPlaneIndependentReviewAttestationEnvelope,
  type ExactControlPlaneChange,
  type ProtectedCapabilityEntry,
} from '../src/modules/authority/intervention-control.ts';
import {
  createControlPlanePromotionBundle,
  createControlPlaneRecoveryBundle,
  initializeControlPlaneSupervisorState,
  persistControlPlaneApprovalCandidate,
  preflightControlPlaneApprovalCandidate,
} from '../src/application/control-plane/intervention-control-updater.ts';
import { loadProtectedCapabilitiesFromTrustBase } from '../src/adapters/consumer/expense-app/work-registry/protected-capabilities.ts';
import {
  bootstrapInterventionStateRoot,
  readBuiltInControlPlaneEngineArtifact,
  resolveControlPlaneEngineSelection,
} from '../bootstrap/control-plane-trust.ts';
import { createFixtureRepository, git } from './fixture.ts';
import {
  CONTROL_PLANE_FIXTURE_REPOSITORY_ID,
  setupFinalizedControlPlanePromotionFixture,
} from './control-plane-promotion-fixture.ts';

const SOURCE_ENGINE_ROOT = path.resolve(import.meta.dirname, '..');
const FIXTURE_ORIGIN = 'https://github.com/example/fixture.git';
const RECOVERY_PUBLIC_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJL6dVljsgm9EAbjCiOhA/tKsgApOhKmcB/NRewL1uns';
const RECOVERY_FINGERPRINT =
  'SHA256:7UB1aHADtIMUJBFt3sjo9RwoBDgCKc1B1GlEucUDL4U';
const BOOTSTRAP_RUNTIME_NAMES = [
  'built-in-engine-closure-pin.ts',
  'canonical-json.ts',
  'control-plane-trust.ts',
] as const;
const FIXTURE_PROTECTED_CAPABILITY_LOADER_PATH =
  'src/adapters/consumer/expense-app/work-registry/protected-capabilities.ts';

test('sealed launcher initializes generation-one supervisor from the verified built-in closure and replays exactly', () => {
  const engineRoot = createSealedEnginePackage();
  const repository = createRepository(engineRoot, 'github:R_bootstrap_fixture');

  try {
    const help = runLauncher(engineRoot, repository, ['--help']);
    assert.equal(help.status, 0, help.stderr);
    assert.equal(fs.existsSync(supervisorPath(repository)), false);
    const status = runLauncher(engineRoot, repository, [
      'status',
      'fixture-session',
      '--json',
    ]);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(fs.existsSync(supervisorPath(repository)), false);

    const initialized = runInitialize(engineRoot, repository);
    assert.equal(initialized.status, 0, initialized.stderr);
    assert.equal(
      JSON.parse(initialized.stdout).kind,
      'control-plane-initialization.v1',
    );

    const first = runLauncher(engineRoot, repository, ['fixture-command']);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /"kind":"fixture-built-in-engine"/);

    const statePath = supervisorPath(repository);
    assert.equal(fs.existsSync(statePath), true);
    const firstBytes = fs.readFileSync(statePath, 'utf8');
    const firstState = JSON.parse(firstBytes) as {
      repositoryId: string;
      generation: number;
      transition: unknown;
      activeArtifact: {
        artifactId: string;
        closureDigest: string;
        executableDigest: string;
        executablePath: string;
      };
      recordDigest: string;
    };
    assert.equal(firstState.repositoryId, 'github:R_bootstrap_fixture');
    assert.equal(firstState.generation, 1);
    assert.equal(firstState.transition, null);
    assert.equal(
      firstState.activeArtifact.closureDigest,
      protectedManifest(repository).manifestDigest,
    );
    assert.match(firstState.activeArtifact.artifactId, /^sha256:[0-9a-f]{64}$/);
    assert.match(
      firstState.activeArtifact.closureDigest,
      /^sha256:[0-9a-f]{64}$/,
    );
    assert.match(
      firstState.activeArtifact.executableDigest,
      /^sha256:[0-9a-f]{64}$/,
    );
    assert.equal(
      firstState.activeArtifact.executablePath.startsWith(
        `${stateRoot(repository)}${path.sep}control-plane-artifacts${path.sep}`,
      ),
      true,
    );
    assert.equal(
      fs.statSync(firstState.activeArtifact.executablePath).mode & 0o777,
      0o500,
    );

    const replay = runInitialize(engineRoot, repository);
    assert.equal(replay.status, 0, replay.stderr);
    assert.equal(fs.readFileSync(statePath, 'utf8'), firstBytes);

    assertFirstPromotionPreflight(repository, firstState.activeArtifact);
  } finally {
    fs.rmSync(engineRoot, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('initial supervisor bootstrap allows local namespaces and exactly replays a fully materialized artifact after a crash', async () => {
  const engineRoot = createSealedEnginePackage();
  const withLocalState = createRepository(
    engineRoot,
    'github:R_local_state_fixture',
  );
  const replay = createRepository(engineRoot, 'github:R_crash_replay_fixture');
  const mismatch = createRepository(
    engineRoot,
    'github:R_crash_mismatch_fixture',
  );

  try {
    const localStateRoot = stateRoot(withLocalState);
    fs.mkdirSync(path.join(localStateRoot, 'checkpoints'), {
      recursive: true,
      mode: 0o700,
    });
    fs.writeFileSync(
      path.join(localStateRoot, 'checkpoints', 'local-checkpoint.json'),
      '{}\n',
      { mode: 0o600 },
    );
    const initializedWithLocalState = runInitialize(engineRoot, withLocalState);
    assert.equal(
      initializedWithLocalState.status,
      0,
      initializedWithLocalState.stderr,
    );

    const replayInitializer = await fixtureInitializer(replay);
    assert.throws(
      () =>
        initializeWithCrashHook(
          replay,
          'ARTIFACT_MATERIALIZED',
          replayInitializer,
        ),
      /simulated bootstrap hard crash/,
    );
    const recovered = runInitialize(engineRoot, replay);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(fs.existsSync(supervisorPath(replay)), true);
    const replayState = JSON.parse(
      fs.readFileSync(supervisorPath(replay), 'utf8'),
    ) as { activeArtifact: { executablePath: string } };

    const mismatchInitializer = await fixtureInitializer(mismatch);
    assert.throws(
      () =>
        initializeWithCrashHook(
          mismatch,
          'ARTIFACT_MATERIALIZED',
          mismatchInitializer,
        ),
      /simulated bootstrap hard crash/,
    );
    const mismatchArtifactRoot = path.join(
      stateRoot(mismatch),
      'control-plane-artifacts',
    );
    const [mismatchArtifactId] = fs.readdirSync(mismatchArtifactRoot);
    assert.ok(mismatchArtifactId);
    const mismatchExecutable = path.join(
      mismatchArtifactRoot,
      mismatchArtifactId,
      'engine',
    );
    fs.chmodSync(mismatchExecutable, 0o700);
    fs.appendFileSync(mismatchExecutable, '\n// crash residue tamper\n');
    const rejected = runInitialize(engineRoot, mismatch);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /CONTROL_PLANE_BOOTSTRAP_ARTIFACT_MISMATCH/);
    assert.equal(fs.existsSync(supervisorPath(mismatch)), false);

    assert.equal(
      fs.existsSync(replayState.activeArtifact.executablePath),
      true,
    );
  } finally {
    fs.rmSync(engineRoot, { recursive: true, force: true });
    fs.rmSync(withLocalState, { recursive: true, force: true });
    fs.rmSync(replay, { recursive: true, force: true });
    fs.rmSync(mismatch, { recursive: true, force: true });
  }
});

test('initial supervisor bootstrap rejects dirty repositories, non-empty state, and repository identity drift', () => {
  const engineRoot = createSealedEnginePackage();
  const dirty = createRepository(engineRoot, 'github:R_dirty_fixture');
  const nonEmpty = createRepository(engineRoot, 'github:R_nonempty_fixture');
  const identityDrift = createRepository(
    engineRoot,
    'github:R_identity_fixture',
  );

  try {
    fs.writeFileSync(path.join(dirty, 'untracked.txt'), 'dirty\n');
    const dirtyResult = runInitialize(engineRoot, dirty);
    assert.notEqual(dirtyResult.status, 0);
    assert.match(
      dirtyResult.stderr,
      /CONTROL_PLANE_BOOTSTRAP_REPOSITORY_DIRTY/,
    );
    assert.equal(fs.existsSync(supervisorPath(dirty)), false);

    fs.mkdirSync(stateRoot(nonEmpty), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(stateRoot(nonEmpty), 'unexpected.json'),
      '{}\n',
      { mode: 0o600 },
    );
    const nonEmptyResult = runInitialize(engineRoot, nonEmpty);
    assert.notEqual(nonEmptyResult.status, 0);
    assert.match(
      nonEmptyResult.stderr,
      /CONTROL_PLANE_BOOTSTRAP_STATE_NOT_EMPTY/,
    );
    assert.equal(fs.existsSync(supervisorPath(nonEmpty)), false);

    const initialized = runInitialize(engineRoot, identityDrift);
    assert.equal(initialized.status, 0, initialized.stderr);
    installRepositoryIdentity(identityDrift, 'github:R_different_fixture');
    const mismatched = runLauncher(engineRoot, identityDrift, [
      'fixture-command',
    ]);
    assert.notEqual(mismatched.status, 0);
    assert.match(
      mismatched.stderr,
      /CONTROL_PLANE_SUPERVISOR_REPOSITORY_MISMATCH/,
    );
  } finally {
    fs.rmSync(engineRoot, { recursive: true, force: true });
    fs.rmSync(dirty, { recursive: true, force: true });
    fs.rmSync(nonEmpty, { recursive: true, force: true });
    fs.rmSync(identityDrift, { recursive: true, force: true });
  }
});

test('initial supervisor bootstrap fails closed when the pinned built-in closure changed', () => {
  const engineRoot = createSealedEnginePackage();
  const repository = createRepository(engineRoot, 'github:R_tampered_fixture');

  try {
    const trackedEntrypoint = path.join(
      repositoryEngineRoot(repository),
      'src/cli.ts',
    );
    fs.appendFileSync(trackedEntrypoint, "process.stderr.write('tampered');\n");
    git(repository, ['add', 'packages/workflow-engine/src/cli.ts']);
    git(repository, ['commit', '-m', 'Tamper tracked built-in closure']);
    git(repository, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    const result = runInitialize(engineRoot, repository);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /BUILT_IN_ENGINE_CLOSURE_MISMATCH/);
    assert.equal(fs.existsSync(supervisorPath(repository)), false);
  } finally {
    fs.rmSync(engineRoot, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('initial supervisor bootstrap rejects stale protected capability content digests from HEAD', () => {
  const engineRoot = createSealedEnginePackage();
  const repository = createRepository(
    engineRoot,
    'github:R_stale_protected_fixture',
  );

  try {
    const protectedFile = path.join(
      repository,
      'protected/adoption.journal/entry.ts',
    );
    fs.appendFileSync(protectedFile, 'changed without manifest refresh\n');
    git(repository, ['add', 'protected/adoption.journal/entry.ts']);
    git(repository, [
      'commit',
      '-m',
      'Change protected bytes without manifest',
    ]);
    git(repository, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);

    const result = runInitialize(engineRoot, repository);
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /CONTROL_PLANE_BOOTSTRAP_PROTECTED_MANIFEST_INVALID/,
    );
    assert.equal(fs.existsSync(supervisorPath(repository)), false);
  } finally {
    fs.rmSync(engineRoot, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('initial supervisor bootstrap rejects external package roots, feature branches, and detached HEAD', () => {
  const engineRoot = createSealedEnginePackage();
  const externalRootRepository = createRepository(
    engineRoot,
    'github:R_external_package_fixture',
  );
  const featureRepository = createRepository(
    engineRoot,
    'github:R_feature_branch_fixture',
  );
  const detachedRepository = createRepository(
    engineRoot,
    'github:R_detached_fixture',
  );

  try {
    const external = runLauncherFromRoot(engineRoot, externalRootRepository, [
      'control-plane',
      'initialize',
      '--json',
    ]);
    assert.notEqual(external.status, 0);
    assert.match(
      external.stderr,
      /CONTROL_PLANE_BOOTSTRAP_PACKAGE_ROOT_INVALID/,
    );
    assert.equal(fs.existsSync(supervisorPath(externalRootRepository)), false);

    git(featureRepository, ['switch', '-c', 'feature/bootstrap-attack']);
    const feature = runInitialize(engineRoot, featureRepository);
    assert.notEqual(feature.status, 0);
    assert.match(feature.stderr, /CONTROL_PLANE_BOOTSTRAP_BASE_MISMATCH/);
    assert.equal(fs.existsSync(supervisorPath(featureRepository)), false);

    git(detachedRepository, ['switch', '--detach', 'HEAD']);
    const detached = runInitialize(engineRoot, detachedRepository);
    assert.notEqual(detached.status, 0);
    assert.match(detached.stderr, /CONTROL_PLANE_BOOTSTRAP_BASE_MISMATCH/);
    assert.equal(fs.existsSync(supervisorPath(detachedRepository)), false);
  } finally {
    fs.rmSync(engineRoot, { recursive: true, force: true });
    fs.rmSync(externalRootRepository, { recursive: true, force: true });
    fs.rmSync(featureRepository, { recursive: true, force: true });
    fs.rmSync(detachedRepository, { recursive: true, force: true });
  }
});

test('ordinary launch fails closed on every authority-bearing or unknown global residue without a supervisor', () => {
  const engineRoot = createSealedEnginePackage();
  const globalResidues = [
    'control-plane-approval-candidates',
    'control-updates',
    'operations',
  ];
  const repositories = [...globalResidues, 'unknown-root-entry'].map(
    (name) => ({
      name,
      repository: createRepository(engineRoot, `github:R_residue_${name}`),
    }),
  );
  const local = createRepository(engineRoot, 'github:R_local_only_residue');

  try {
    for (const { name, repository } of repositories) {
      const root = stateRoot(repository);
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      if (name === 'unknown-root-entry') {
        fs.writeFileSync(path.join(root, 'unknown.json'), '{}\n', {
          mode: 0o600,
        });
      } else {
        const directory = path.join(root, name);
        fs.mkdirSync(directory, { mode: 0o700 });
        fs.writeFileSync(path.join(directory, 'persisted.json'), '{}\n', {
          mode: 0o600,
        });
      }
      const result = runLauncher(engineRoot, repository, ['fixture-command']);
      assert.notEqual(result.status, 0, `${name}: ${result.stderr}`);
      assert.match(result.stderr, /CONTROL_PLANE_SUPERVISOR_CORRUPT/);
    }

    const localRoot = stateRoot(local);
    for (const name of [
      'checkpoints',
      'interventions',
      'sidecar-sessions',
      'adoptions',
      'local-parent-sessions',
      'local-engine-artifacts',
    ]) {
      fs.mkdirSync(path.join(localRoot, name), {
        recursive: true,
        mode: 0o700,
      });
    }
    const localResult = runLauncher(engineRoot, local, ['fixture-command']);
    assert.equal(localResult.status, 0, localResult.stderr);
    assert.equal(fs.existsSync(supervisorPath(local)), false);
  } finally {
    fs.rmSync(engineRoot, { recursive: true, force: true });
    for (const { repository } of repositories) {
      fs.rmSync(repository, { recursive: true, force: true });
    }
    fs.rmSync(local, { recursive: true, force: true });
  }
});

test('initial supervisor bootstrap rejects a self-consistent local main not authorized by origin main', () => {
  const engineRoot = createSealedEnginePackage();
  const repository = createRepository(
    engineRoot,
    'github:R_remote_base_attack',
  );

  try {
    const entrypoint = path.join(
      repositoryEngineRoot(repository),
      'src/cli.ts',
    );
    fs.appendFileSync(
      entrypoint,
      "process.stderr.write('local-main-attack');\n",
    );
    regenerateFixtureEngineClosure(repository);
    writeFixtureProtectedManifest(repository);
    git(repository, ['add', '.']);
    git(repository, [
      'commit',
      '-m',
      'Regenerate self-consistent local engine',
    ]);

    const result = runInitialize(engineRoot, repository);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CONTROL_PLANE_BOOTSTRAP_REMOTE_BASE_MISMATCH/);
    assert.equal(fs.existsSync(supervisorPath(repository)), false);
  } finally {
    fs.rmSync(engineRoot, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('ordinary launch rejects a forged generation-one supervisor without completed bootstrap provenance', () => {
  const engineRoot = createSealedEnginePackage();
  const repository = createRepository(
    engineRoot,
    'github:R_forged_generation_one',
  );

  try {
    const closureDigest = digest('forged-generation-one-closure');
    const source = forgedSupervisorSource(closureDigest);
    const artifact = createEngineArtifact({
      sourceChangeId: 'forged-generation-one',
      sourceDigest: digest('forged-source'),
      executableDigest: digest(source),
      protocolVersion: 3,
      canReadSessionSchemas: ['v4'],
      writesSessionSchema: 'v4',
      policySchemaVersion: 2,
      smokeReportDigest: digest('forged-smoke'),
    });
    initializeControlPlaneSupervisorState(stateRoot(repository), {
      repositoryId: 'github:R_forged_generation_one',
      closureDigest,
      artifact,
      executableBase64: Buffer.from(source).toString('base64'),
      now: new Date('2026-08-10T10:00:00.000Z'),
    });

    const result = runLauncher(engineRoot, repository, ['fixture-command']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CONTROL_PLANE_SUPERVISOR_NOT_TERMINAL/);
  } finally {
    fs.rmSync(engineRoot, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('ordinary launch rejects a self-digested V1 terminal and never executes its probe-capable artifact', () => {
  const engineRoot = createSealedEnginePackage();
  const repository = createRepository(
    engineRoot,
    'github:R_v1_terminal_downgrade',
  );
  const marker = path.join(repository, 'v1-terminal-executed');
  try {
    const initialized = runInitialize(engineRoot, repository);
    assert.equal(initialized.status, 0, initialized.stderr);
    const storageRoot = stateRoot(repository);
    const initial = readJsonRecord(supervisorPath(repository));
    const repositoryId = String(initial.repositoryId);
    const grantId = 'forged-v1-terminal-grant';
    const txId = 'forged-v1-terminal-tx';
    const closureDigest = digest('forged-v1-terminal-closure');
    const executableBytes = Buffer.from(`#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] === '--control-plane-restart-probe') {
  process.stdout.write(JSON.stringify({kind:'control-plane-restart.v1',ready:true,closureDigest:${JSON.stringify(closureDigest)}}) + '\\n');
} else {
  fs.writeFileSync(${JSON.stringify(marker)}, 'executed\\n');
  process.stdout.write('forged v1 terminal executed\\n');
}
`);
    const executableDigest = digest(executableBytes);
    const artifactId = digest('forged-v1-terminal-artifact');
    const artifactDirectory = path.join(
      storageRoot,
      'control-plane-artifacts',
      artifactId.slice('sha256:'.length),
    );
    fs.mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });
    const executablePath = path.join(artifactDirectory, 'engine');
    fs.writeFileSync(executablePath, executableBytes, { mode: 0o500 });
    fs.chmodSync(executablePath, 0o500);

    const history = [
      'PREPARED',
      'OLD_CLOSURE_VERIFIED',
      'CANDIDATE_VERIFIED',
      'RECOVERY_VERIFIED',
      'SWITCHED',
      'SELF_TESTED',
      'FINALIZED',
    ].map((state, index) => ({
      state,
      at: new Date(Date.UTC(2026, 7, 10, 12, 0, 0, index)).toISOString(),
    }));
    const transaction: Record<string, unknown> = {
      kind: 'minimal-control-plane-updater.v1',
      txId,
      grantId,
      candidateDigest: digest('forged-v1-terminal-candidate'),
      beforeClosureDigest: String(
        recordField(initial, 'activeArtifact').closureDigest,
      ),
      afterClosureDigest: closureDigest,
      recoveryBundleDigest: digest('forged-v1-terminal-recovery'),
      updaterVersion: 1,
      state: 'FINALIZED',
      history,
    };
    transaction.journalDigest = recordDigest(transaction, 'journalDigest');
    const record: Record<string, unknown> = {
      kind: 'persisted-control-plane-update.v1',
      grantState: 'consumed',
      transaction,
      envelope: {
        payload: {
          grantId,
          repositoryId,
          candidateDigest: transaction.candidateDigest,
          beforeClosureDigest: transaction.beforeClosureDigest,
          afterClosureDigest: transaction.afterClosureDigest,
          updaterVersion: 1,
        },
        signature: 'attacker-controlled-v1-signature',
      },
      beforeManifest: { manifestDigest: transaction.beforeClosureDigest },
      afterManifest: { manifestDigest: transaction.afterClosureDigest },
      changes: [],
      observations: [],
      createdAt: history[0]!.at,
      updatedAt: history.at(-1)!.at,
      effectsPerformed: false,
    };
    record.recordDigest = recordDigest(record, 'recordDigest');
    const updates = path.join(storageRoot, 'control-updates');
    fs.mkdirSync(updates, { mode: 0o700 });
    writeJsonRecord(
      path.join(
        updates,
        `${crypto.createHash('sha256').update(`control-update\0${grantId}`).digest('hex')}.json`,
      ),
      record,
    );
    const supervisor: Record<string, unknown> = {
      kind: 'control-plane-supervisor-state.v1',
      repositoryId,
      activeArtifact: {
        artifactId,
        executableDigest,
        closureDigest,
        executablePath,
      },
      generation: 2,
      transition: { grantId, txId, phase: 'candidate-selected' },
      updatedAt: record.updatedAt,
    };
    supervisor.recordDigest = recordDigest(supervisor, 'recordDigest');
    writeJsonRecord(supervisorPath(repository), supervisor);

    const rejected = runLauncher(engineRoot, repository, ['fixture-command']);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /CONTROL_PLANE_SUPERVISOR_NOT_TERMINAL/);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fs.rmSync(engineRoot, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('active Recovery Quarantine fences built-in and promoted engines before any probe', async () => {
  const engineRoot = createSealedEnginePackage();
  const builtInRepository = createRepository(
    engineRoot,
    'github:R_recovery_quarantine_builtin_fixture',
  );
  const promoted = await setupFinalizedControlPlanePromotionFixture();
  let builtInQuarantine: ReturnType<
    typeof installActiveRecoveryQuarantineMarker
  > | null = null;
  let promotedQuarantine: ReturnType<
    typeof installActiveRecoveryQuarantineMarker
  > | null = null;

  try {
    builtInQuarantine = installActiveRecoveryQuarantineMarker(
      builtInRepository,
      'github:R_recovery_quarantine_builtin_fixture',
    );
    for (const argv of [
      ['fixture-command'],
      ['--help'],
      ['status', 'fixture-session', '--json'],
      ['intervention', 'status', 'fixture-intervention', '--json'],
      ['control-plane', 'initialize', '--json'],
      ['control-plane', 'rollback'],
      ['control-plane', 'rollback', '-not-an-id'],
      ['control-plane', 'rollback', 'fixture-source-grant', '--json', 'extra'],
      [
        'recovery-authority',
        'status',
        '--expectations',
        '/tmp/fixture-recovery-expectations.json',
      ],
      [
        'recovery-quarantine',
        'enter',
        '/tmp/fixture-recovery-enter.json',
        '--expectations',
        '/tmp/fixture-recovery-expectations.json',
      ],
    ]) {
      const blocked = runLauncher(engineRoot, builtInRepository, argv);
      assert.notEqual(blocked.status, 0, argv.join(' '));
      assert.match(blocked.stderr, /WORKFLOW_RECOVERY_QUARANTINED/);
      assert.doesNotMatch(blocked.stdout, /fixture-built-in-engine/);
    }

    const sealedRecovery = runLauncher(engineRoot, builtInRepository, [
      'control-plane',
      'rollback',
      'fixture-source-grant',
      '--json',
    ]);
    assert.notEqual(sealedRecovery.status, 0);
    assert.doesNotMatch(sealedRecovery.stderr, /WORKFLOW_RECOVERY_QUARANTINED/);
    assert.doesNotMatch(sealedRecovery.stdout, /fixture-built-in-engine/);

    const sealedRelease = runLauncher(engineRoot, builtInRepository, [
      'recovery-quarantine',
      'release',
      '/tmp/fixture-recovery-release.json',
      '--expectations',
      '/tmp/fixture-recovery-expectations.json',
      '--json',
    ]);
    assert.notEqual(sealedRelease.status, 0);
    assert.doesNotMatch(sealedRelease.stderr, /WORKFLOW_RECOVERY_QUARANTINED/);
    assert.doesNotMatch(sealedRelease.stdout, /fixture-built-in-engine/);

    builtInQuarantine.release();
    const released = runLauncher(engineRoot, builtInRepository, [
      'fixture-command',
    ]);
    assert.equal(released.status, 0, released.stderr);
    assert.match(released.stdout, /fixture-built-in-engine/);

    promotedQuarantine = installActiveRecoveryQuarantineMarker(
      promoted.repository,
      CONTROL_PLANE_FIXTURE_REPOSITORY_ID,
    );
    const promotedProbe = runLauncher(SOURCE_ENGINE_ROOT, promoted.repository, [
      '--control-plane-self-test',
    ]);
    assert.notEqual(promotedProbe.status, 0);
    assert.match(promotedProbe.stderr, /WORKFLOW_RECOVERY_QUARANTINED/);
    assert.doesNotMatch(promotedProbe.stdout, /control-plane-self-test/);
  } finally {
    fs.rmSync(engineRoot, { recursive: true, force: true });
    fs.rmSync(builtInRepository, { recursive: true, force: true });
    builtInQuarantine?.cleanup();
    promotedQuarantine?.cleanup();
    promoted.cleanup();
  }
});

test('Recovery Quarantine canonical inventory rejects tamper and ignores noncanonical markers', () => {
  const engineRoot = createSealedEnginePackage();
  const repositories: string[] = [];
  const quarantines: Array<
    ReturnType<typeof installActiveRecoveryQuarantineMarker>
  > = [];
  const fixture = (suffix: string) => {
    const repositoryId = `github:R_recovery_quarantine_${suffix}`;
    const repository = createRepository(engineRoot, repositoryId);
    repositories.push(repository);
    const quarantine = installActiveRecoveryQuarantineMarker(
      repository,
      repositoryId,
    );
    quarantines.push(quarantine);
    return { repository, quarantine };
  };
  const assertCorrupt = (repository: string) => {
    const result = runLauncher(engineRoot, repository, ['fixture-command']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /WORKFLOW_RECOVERY_QUARANTINE_STATE_CORRUPT/);
    assert.doesNotMatch(result.stdout, /fixture-built-in-engine/);
  };

  try {
    const tampered = fixture('tampered');
    const marker = JSON.parse(
      fs.readFileSync(tampered.quarantine.markerPath, 'utf8'),
    ) as Record<string, unknown>;
    marker.enteredAt = '2026-08-10T12:00:02.000Z';
    writeJsonRecord(tampered.quarantine.markerPath, marker);
    assertCorrupt(tampered.repository);

    const unknown = fixture('unknown');
    fs.writeFileSync(
      path.join(
        recoveryAuthorityStateRoot(unknown.repository),
        'operator-note',
      ),
      'unknown\n',
      { mode: 0o600 },
    );
    assertCorrupt(unknown.repository);

    const residue = fixture('residue');
    fs.writeFileSync(
      path.join(
        recoveryAuthorityStateRoot(residue.repository),
        'recovery-quarantine',
        `.active-marker.json.${'0'.repeat(64)}.${crypto.randomUUID()}.tmp`,
      ),
      '{}\n',
      { mode: 0o600 },
    );
    assertCorrupt(residue.repository);

    const hardLinked = fixture('hardlink');
    fs.linkSync(
      hardLinked.quarantine.markerPath,
      path.join(hardLinked.repository, 'marker-alias.json'),
    );
    assertCorrupt(hardLinked.repository);

    const symlinked = fixture('symlink');
    const canonical = recoveryAuthorityStateRoot(symlinked.repository);
    const target = `${canonical}-target`;
    fs.renameSync(canonical, target);
    fs.symlinkSync(target, canonical);
    assertCorrupt(symlinked.repository);

    const outside = fixture('outside');
    const outsideCanonical = recoveryAuthorityStateRoot(outside.repository);
    fs.renameSync(outsideCanonical, `${outsideCanonical}-shadow`);
    const allowed = runLauncher(engineRoot, outside.repository, [
      'fixture-command',
    ]);
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.match(allowed.stdout, /fixture-built-in-engine/);
  } finally {
    for (const quarantine of quarantines) quarantine.cleanup();
    for (const repository of repositories) {
      fs.rmSync(repository, { recursive: true, force: true });
    }
    fs.rmSync(engineRoot, { recursive: true, force: true });
  }
});

test('generation-one selection allows an advanced origin descendant and rejects rewritten origin history', () => {
  const engineRoot = createSealedEnginePackage();
  const advanced = createRepository(engineRoot, 'github:R_remote_advanced');
  const rewritten = createRepository(engineRoot, 'github:R_remote_rewritten');

  try {
    assert.equal(runInitialize(engineRoot, advanced).status, 0);
    fs.writeFileSync(
      path.join(advanced, 'after-bootstrap.txt'),
      'descendant\n',
    );
    git(advanced, ['add', 'after-bootstrap.txt']);
    git(advanced, ['commit', '-m', 'Advance trusted origin base']);
    git(advanced, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    const allowed = runLauncher(engineRoot, advanced, ['fixture-command']);
    assert.equal(allowed.status, 0, allowed.stderr);

    assert.equal(runInitialize(engineRoot, rewritten).status, 0);
    git(rewritten, ['update-ref', 'refs/remotes/origin/main', 'HEAD^']);
    const rejected = runLauncher(engineRoot, rewritten, ['fixture-command']);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /CONTROL_PLANE_SUPERVISOR_NOT_TERMINAL/);
  } finally {
    fs.rmSync(engineRoot, { recursive: true, force: true });
    fs.rmSync(advanced, { recursive: true, force: true });
    fs.rmSync(rewritten, { recursive: true, force: true });
  }
});

test('initial supervisor bootstrap rechecks exact HEAD and tree before any durable write', async () => {
  const engineRoot = createSealedEnginePackage();
  const repository = createRepository(engineRoot, 'github:R_toctou_fixture');

  try {
    const initialize = await fixtureInitializer(repository);
    assert.throws(
      () =>
        initialize(
          stateRoot(repository),
          repositoryEngineRoot(repository),
          repositoryIdentity(repository),
          new Date('2026-08-10T10:00:00.000Z'),
          {
            testAfterProvenanceCapture() {
              fs.appendFileSync(path.join(repository, 'package.json'), ' \n');
              git(repository, ['add', 'package.json']);
              git(repository, ['commit', '-m', 'Move HEAD after capture']);
            },
          },
        ),
      (error) =>
        errorCode(error) === 'CONTROL_PLANE_BOOTSTRAP_PROVENANCE_CHANGED',
    );
    assert.equal(fs.existsSync(supervisorPath(repository)), false);
    assert.equal(fs.existsSync(bootstrapJournalDirectory(repository)), false);
  } finally {
    fs.rmSync(engineRoot, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('initial supervisor journal reconciles exact crash residues and rejects malformed, multiple, or symlink residues', async () => {
  const engineRoot = createSealedEnginePackage();
  const recoverable = createRepository(engineRoot, 'github:R_journal_replay');
  const unsafeRepositories = ['malformed', 'multiple', 'symlink'].map(
    (kind) => ({
      kind,
      repository: createRepository(engineRoot, `github:R_journal_${kind}`),
    }),
  );

  try {
    const recoverableInitializer = await fixtureInitializer(recoverable);
    assert.throws(
      () =>
        initializeWithCrashHook(
          recoverable,
          'ARTIFACT_MATERIALIZED',
          recoverableInitializer,
        ),
      /simulated bootstrap hard crash/,
    );
    assert.equal(fs.existsSync(supervisorPath(recoverable)), false);
    assert.equal(fs.existsSync(bootstrapJournalDirectory(recoverable)), true);
    const recovered = runInitialize(engineRoot, recoverable);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(fs.existsSync(supervisorPath(recoverable)), true);

    for (const { kind, repository } of unsafeRepositories) {
      const initialize = await fixtureInitializer(repository);
      assert.throws(
        () => initializeWithCrashHook(repository, 'PREPARED', initialize),
        /simulated bootstrap hard crash/,
      );
      const journal = bootstrapJournalDirectory(repository);
      if (kind === 'malformed') {
        fs.writeFileSync(
          path.join(journal, '01-artifact-materialized.json.pending'),
          '{',
          { mode: 0o600 },
        );
      } else if (kind === 'multiple') {
        fs.writeFileSync(path.join(journal, 'first.pending'), '{}\n', {
          mode: 0o600,
        });
        fs.writeFileSync(path.join(journal, 'second.pending'), '{}\n', {
          mode: 0o600,
        });
      } else {
        fs.symlinkSync(
          path.join(repository, 'package.json'),
          path.join(journal, '01-artifact-materialized.json.pending'),
        );
      }
      const rejected = runInitialize(engineRoot, repository);
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /CONTROL_PLANE_BOOTSTRAP_JOURNAL_CORRUPT/);
      assert.equal(fs.existsSync(supervisorPath(repository)), false);
    }
  } finally {
    fs.rmSync(engineRoot, { recursive: true, force: true });
    fs.rmSync(recoverable, { recursive: true, force: true });
    for (const { repository } of unsafeRepositories) {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('finalized V2 selection remains durable years after its admission grant expired', async () => {
  const fixture = await setupFinalizedControlPlanePromotionFixture({
    reviewedAt: '2000-01-01T00:00:00.000Z',
    grantIssuedAt: '2000-01-01T00:02:00.000Z',
  });
  try {
    assert.equal(
      Date.parse(fixture.record.envelope.payload.expiresAt) < Date.now(),
      true,
    );
    const selected = resolveControlPlaneEngineSelection(
      fixture.stateRoot,
      CONTROL_PLANE_FIXTURE_REPOSITORY_ID,
    );
    assert.equal(
      selected?.activeArtifact.artifactId,
      fixture.candidateArtifact.artifactId,
    );
  } finally {
    fixture.cleanup();
  }
});

test('first V2 promotion selects its exact generation-three rollback terminal', async () => {
  const fixture = await setupFinalizedControlPlanePromotionFixture();
  try {
    const bundle = readJsonRecord(
      onlyPrivateJsonFile(
        path.join(fixture.stateRoot, 'control-plane-promotion-bundles'),
      ),
    );
    const material = recordField(bundle, 'material');
    const recovery = recordField(material, 'recoveryBundle');
    const restartArtifact = recordField(recovery, 'restartArtifact');

    const updatePath = onlyPrivateJsonFile(
      path.join(fixture.stateRoot, 'control-updates'),
    );
    const update = readJsonRecord(updatePath);
    const transaction = recordField(update, 'transaction');
    const history = transaction.history as Array<Record<string, unknown>>;
    const observations = update.observations as Array<Record<string, unknown>>;
    assert.equal(Array.isArray(history), true);
    assert.equal(Array.isArray(observations), true);
    history.at(-2)!.state = 'ROLLBACK_REQUIRED';
    history.at(-1)!.state = 'ROLLED_BACK';
    observations.at(-2)!.toState = 'ROLLBACK_REQUIRED';
    observations.at(-2)!.eventKind = 'self-tests-failed';
    observations.at(-1)!.fromState = 'ROLLBACK_REQUIRED';
    observations.at(-1)!.toState = 'ROLLED_BACK';
    observations.at(-1)!.eventKind = 'rollback-completed';
    transaction.state = 'ROLLED_BACK';
    transaction.journalDigest = recordDigest(transaction, 'journalDigest');
    update.recordDigest = recordDigest(update, 'recordDigest');
    writeJsonRecord(updatePath, update);

    const supervisorPath = path.join(
      fixture.stateRoot,
      'control-plane-supervisor.json',
    );
    const supervisor = readJsonRecord(supervisorPath);
    supervisor.generation = 3;
    supervisor.activeArtifact = {
      artifactId: restartArtifact.artifactId,
      executableDigest: restartArtifact.executableDigest,
      closureDigest: transaction.beforeClosureDigest,
      executablePath: path.join(
        fixture.stateRoot,
        'control-plane-artifacts',
        String(restartArtifact.artifactId).slice('sha256:'.length),
        'engine',
      ),
    };
    const transition = recordField(supervisor, 'transition');
    transition.phase = 'rollback-restored';
    supervisor.recordDigest = recordDigest(supervisor, 'recordDigest');
    writeJsonRecord(supervisorPath, supervisor);

    const selected = resolveControlPlaneEngineSelection(
      fixture.stateRoot,
      CONTROL_PLANE_FIXTURE_REPOSITORY_ID,
    );
    assert.equal(selected?.generation, 3);
    assert.equal(
      selected?.activeArtifact.artifactId,
      restartArtifact.artifactId,
    );
  } finally {
    fixture.cleanup();
  }
});

test('finalized V2 selection rejects fully redigested but untrusted review and grant signatures', async () => {
  const fixture = await setupFinalizedControlPlanePromotionFixture();
  try {
    const bundlePath = onlyPrivateJsonFile(
      path.join(fixture.stateRoot, 'control-plane-promotion-bundles'),
    );
    const bundle = readJsonRecord(bundlePath);
    const reviewEnvelope = recordField(bundle, 'independentReviewAttestation');
    reviewEnvelope.signature = 'structurally-valid-untrusted-review-signature';
    bundle.bundleDigest = recordDigest(bundle, 'bundleDigest');

    const updatePath = onlyPrivateJsonFile(
      path.join(fixture.stateRoot, 'control-updates'),
    );
    const update = readJsonRecord(updatePath);
    const envelope = recordField(update, 'envelope');
    const payload = recordField(envelope, 'payload');
    payload.independentReviewAttestationDigest = digest(
      canonicalJson(reviewEnvelope),
    );
    payload.promotionBundleDigest = bundle.bundleDigest;
    envelope.signature = 'structurally-valid-untrusted-grant-signature';
    update.recordDigest = recordDigest(update, 'recordDigest');

    writeJsonRecord(bundlePath, bundle);
    writeJsonRecord(updatePath, update);
    assertTerminalSelectionRejected(fixture.stateRoot);
  } finally {
    fixture.cleanup();
  }
});

test('first V2 promotion rejects forged supervisor generations and additional authority-update inventory', async () => {
  const forgedGeneration = await setupFinalizedControlPlanePromotionFixture();
  try {
    const supervisorPath = path.join(
      forgedGeneration.stateRoot,
      'control-plane-supervisor.json',
    );
    const supervisor = readJsonRecord(supervisorPath);
    supervisor.generation = 999;
    supervisor.recordDigest = recordDigest(supervisor, 'recordDigest');
    writeJsonRecord(supervisorPath, supervisor);
    assertTerminalSelectionRejected(forgedGeneration.stateRoot);
  } finally {
    forgedGeneration.cleanup();
  }

  const additionalUpdate = await setupFinalizedControlPlanePromotionFixture();
  try {
    const updateDirectory = path.join(
      additionalUpdate.stateRoot,
      'control-updates',
    );
    const updatePath = onlyPrivateJsonFile(updateDirectory);
    fs.copyFileSync(
      updatePath,
      path.join(updateDirectory, `${'f'.repeat(64)}.json`),
    );
    fs.chmodSync(path.join(updateDirectory, `${'f'.repeat(64)}.json`), 0o600);
    assertTerminalSelectionRejected(additionalUpdate.stateRoot);
  } finally {
    additionalUpdate.cleanup();
  }
});

test('finalized V2 selection rejects nonterminal history and unsafe private candidate storage', async () => {
  const nonterminal = await setupFinalizedControlPlanePromotionFixture();
  try {
    const updatePath = onlyPrivateJsonFile(
      path.join(nonterminal.stateRoot, 'control-updates'),
    );
    const update = readJsonRecord(updatePath);
    const transaction = recordField(update, 'transaction');
    const history = transaction.history;
    const observations = update.observations;
    assert.equal(Array.isArray(history), true);
    assert.equal(Array.isArray(observations), true);
    transaction.state = 'SELF_TESTED';
    transaction.history = (history as unknown[]).slice(0, -1);
    transaction.journalDigest = recordDigest(transaction, 'journalDigest');
    update.observations = (observations as unknown[]).slice(0, -1);
    const lastHistory = (transaction.history as unknown[]).at(-1);
    assert.equal(
      typeof lastHistory === 'object' &&
        lastHistory !== null &&
        !Array.isArray(lastHistory),
      true,
    );
    const lastHistoryAt = (lastHistory as Record<string, unknown>).at;
    assert.equal(typeof lastHistoryAt, 'string');
    update.updatedAt = lastHistoryAt;
    update.recordDigest = recordDigest(update, 'recordDigest');
    writeJsonRecord(updatePath, update);
    assertTerminalSelectionRejected(nonterminal.stateRoot);
  } finally {
    nonterminal.cleanup();
  }

  const unsafeCandidate = await setupFinalizedControlPlanePromotionFixture();
  try {
    const gitCommonDirectory = fs.realpathSync(
      git(unsafeCandidate.repository, [
        'rev-parse',
        '--path-format=absolute',
        '--git-common-dir',
      ]).trim(),
    );
    const candidatePath = path.join(
      gitCommonDirectory,
      'workflow-engine',
      'candidates',
      `${unsafeCandidate.frozen.candidateBundleDigest}.json`,
    );
    const original = fs.readFileSync(candidatePath);

    fs.chmodSync(candidatePath, 0o644);
    assertTerminalSelectionRejected(unsafeCandidate.stateRoot);
    fs.chmodSync(candidatePath, 0o600);
    assertTerminalSelectionAccepted(unsafeCandidate.stateRoot);

    const parsed = JSON.parse(original.toString('utf8')) as unknown;
    fs.writeFileSync(candidatePath, `${JSON.stringify(parsed, null, 2)}\n`, {
      mode: 0o600,
    });
    assertTerminalSelectionRejected(unsafeCandidate.stateRoot);
    fs.writeFileSync(candidatePath, original, { mode: 0o600 });
    assertTerminalSelectionAccepted(unsafeCandidate.stateRoot);

    const aliasPath = `${candidatePath}.alias`;
    fs.linkSync(candidatePath, aliasPath);
    assertTerminalSelectionRejected(unsafeCandidate.stateRoot);
    fs.unlinkSync(aliasPath);
    assertTerminalSelectionAccepted(unsafeCandidate.stateRoot);

    const savedPath = `${candidatePath}.saved`;
    fs.renameSync(candidatePath, savedPath);
    fs.symlinkSync(savedPath, candidatePath);
    assertTerminalSelectionRejected(unsafeCandidate.stateRoot);
    fs.unlinkSync(candidatePath);
    fs.renameSync(savedPath, candidatePath);
    assertTerminalSelectionAccepted(unsafeCandidate.stateRoot);
  } finally {
    unsafeCandidate.cleanup();
  }
});

function assertTerminalSelectionAccepted(stateRoot: string): void {
  assert.notEqual(
    resolveControlPlaneEngineSelection(
      stateRoot,
      CONTROL_PLANE_FIXTURE_REPOSITORY_ID,
    ),
    null,
  );
}

function assertTerminalSelectionRejected(stateRoot: string): void {
  assert.throws(
    () =>
      resolveControlPlaneEngineSelection(
        stateRoot,
        CONTROL_PLANE_FIXTURE_REPOSITORY_ID,
      ),
    (error) => errorCode(error) === 'CONTROL_PLANE_SUPERVISOR_NOT_TERMINAL',
  );
}

function onlyPrivateJsonFile(directory: string): string {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.isFile(), true);
  assert.equal(entries[0]?.isSymbolicLink(), false);
  assert.match(entries[0]?.name ?? '', /^[0-9a-f]{64}\.json$/);
  return path.join(directory, entries[0]!.name);
}

function readJsonRecord(filePath: string): Record<string, unknown> {
  const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  assert.equal(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    true,
  );
  return value as Record<string, unknown>;
}

function recordField(value: unknown, field: string): Record<string, unknown> {
  assert.equal(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    true,
  );
  const fieldValue = (value as Record<string, unknown>)[field];
  assert.equal(
    typeof fieldValue === 'object' &&
      fieldValue !== null &&
      !Array.isArray(fieldValue),
    true,
  );
  return fieldValue as Record<string, unknown>;
}

function recordDigest(
  record: Record<string, unknown>,
  digestField: string,
): `sha256:${string}` {
  const payload = { ...record };
  delete payload[digestField];
  return digest(canonicalJson(payload));
}

function writeJsonRecord(
  filePath: string,
  record: Record<string, unknown>,
): void {
  fs.writeFileSync(filePath, `${canonicalJson(record)}\n`, { mode: 0o600 });
}

function createSealedEnginePackage(): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'control-plane-initial-supervisor-engine-'),
  );
  const bootstrap = path.join(root, 'bootstrap');
  const source = path.join(root, 'src');
  fs.mkdirSync(bootstrap, { recursive: true });
  fs.mkdirSync(source, { recursive: true });
  for (const name of [
    'canonical-json.ts',
    'control-plane-trust.ts',
    'workflow-launcher.ts',
  ]) {
    fs.copyFileSync(
      path.join(SOURCE_ENGINE_ROOT, 'bootstrap', name),
      path.join(bootstrap, name),
    );
  }
  for (const name of [
    'harness-bootstrap-dependency-closure.json',
    'harness-bootstrap-launcher.ts',
    'harness-bootstrap-runtime-closure-pin.ts',
  ]) {
    fs.copyFileSync(
      path.join(SOURCE_ENGINE_ROOT, 'bootstrap', name),
      path.join(bootstrap, name),
    );
  }
  fs.cpSync(
    path.join(SOURCE_ENGINE_ROOT, 'bootstrap', 'recovery-runtime'),
    path.join(bootstrap, 'recovery-runtime'),
    { recursive: true },
  );
  const packageBytes = `${JSON.stringify(
    { name: 'sealed-fixture-engine', private: true, type: 'module' },
    null,
    2,
  )}\n`;
  const entrypointBytes = [
    "import { BUILT_IN_ENGINE_CLOSURE_MANIFEST_DIGEST } from '../bootstrap/built-in-engine-closure-pin.ts';",
    "import { bootstrapInterventionStateRoot } from '../bootstrap/control-plane-trust.ts';",
    'void BUILT_IN_ENGINE_CLOSURE_MANIFEST_DIGEST;',
    'void bootstrapInterventionStateRoot;',
    'const argv = process.argv.slice(2);',
    "process.stdout.write(`${JSON.stringify({ kind: 'fixture-built-in-engine', argv })}\\n`);",
    '',
  ].join('\n');
  const protectedLoaderBytes =
    "export const fixtureProtectedCapabilitiesLoader = 'v1';\n";
  fs.writeFileSync(path.join(root, 'package.json'), packageBytes, {
    mode: 0o644,
  });
  fs.writeFileSync(path.join(source, 'cli.ts'), entrypointBytes, {
    mode: 0o644,
  });
  const protectedLoaderPath = path.join(
    root,
    FIXTURE_PROTECTED_CAPABILITY_LOADER_PATH,
  );
  fs.mkdirSync(path.dirname(protectedLoaderPath), { recursive: true });
  fs.writeFileSync(protectedLoaderPath, protectedLoaderBytes, { mode: 0o644 });
  const manifest = {
    kind: 'built-in-engine-closure-manifest.v1',
    entrypoint: 'src/cli.ts',
    scope: 'package-json-and-all-src-typescript',
    files: [
      {
        path: 'package.json',
        mode: '100644',
        digest: digest(packageBytes),
      },
      {
        path: FIXTURE_PROTECTED_CAPABILITY_LOADER_PATH,
        mode: '100644',
        digest: digest(protectedLoaderBytes),
      },
      {
        path: 'src/cli.ts',
        mode: '100644',
        digest: digest(entrypointBytes),
      },
    ],
  };
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(
    path.join(bootstrap, 'built-in-engine-closure.json'),
    manifestBytes,
    { mode: 0o644 },
  );
  fs.writeFileSync(
    path.join(bootstrap, 'built-in-engine-closure-pin.ts'),
    [
      'export const BUILT_IN_ENGINE_CLOSURE_MANIFEST_DIGEST =',
      `  '${digest(manifestBytes)}' as const;`,
      '',
    ].join('\n'),
    { mode: 0o644 },
  );
  return root;
}

function createRepository(engineRoot: string, repositoryId: string): string {
  const repository = createFixtureRepository();
  installRepositoryIdentity(repository, repositoryId, engineRoot);
  return repository;
}

function installRepositoryIdentity(
  repository: string,
  repositoryId: string,
  engineRoot?: string,
): void {
  const remotes = git(repository, ['remote']).split('\n').filter(Boolean);
  git(repository, [
    'remote',
    remotes.includes('origin') ? 'set-url' : 'add',
    'origin',
    FIXTURE_ORIGIN,
  ]);
  fs.writeFileSync(
    path.join(repository, 'workflow/maintainer-policy.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        repository: { id: repositoryId, origin: FIXTURE_ORIGIN },
      },
      null,
      2,
    )}\n`,
  );
  if (engineRoot !== undefined) {
    fs.cpSync(engineRoot, repositoryEngineRoot(repository), {
      recursive: true,
    });
  }
  writeFixtureProtectedManifest(repository);
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', `Set repository identity ${repositoryId}`]);
  if (engineRoot !== undefined) {
    git(repository, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  }
}

function writeFixtureProtectedManifest(repository: string): void {
  const manifest = createFixtureProtectedManifest(repository);
  const { manifestDigest: _manifestDigest, ...manifestPayload } = manifest;
  fs.writeFileSync(
    path.join(repository, 'workflow/protected-capabilities.json'),
    `${JSON.stringify(manifestPayload, null, 2)}\n`,
  );
}

function regenerateFixtureEngineClosure(repository: string): void {
  const packageRoot = repositoryEngineRoot(repository);
  const files = [
    'package.json',
    FIXTURE_PROTECTED_CAPABILITY_LOADER_PATH,
    'src/cli.ts',
  ].map((filePath) => {
    const bytes = fs.readFileSync(path.join(packageRoot, filePath));
    return {
      path: filePath,
      mode: '100644',
      digest: digest(bytes),
    };
  });
  const manifest = {
    kind: 'built-in-engine-closure-manifest.v1',
    entrypoint: 'src/cli.ts',
    scope: 'package-json-and-all-src-typescript',
    files,
  };
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(
    path.join(packageRoot, 'bootstrap/built-in-engine-closure.json'),
    manifestBytes,
  );
  fs.writeFileSync(
    path.join(packageRoot, 'bootstrap/built-in-engine-closure-pin.ts'),
    [
      'export const BUILT_IN_ENGINE_CLOSURE_MANIFEST_DIGEST =',
      `  '${digest(manifestBytes)}' as const;`,
      '',
    ].join('\n'),
  );
}

function forgedSupervisorSource(closureDigest: string): string {
  return `#!/usr/bin/env node
const mode = process.argv[2];
if (mode === '--control-plane-restart-probe') {
  process.stdout.write(JSON.stringify({kind:'control-plane-restart.v1',ready:true,closureDigest:${JSON.stringify(closureDigest)}}) + '\\n');
  process.exit(0);
}
process.stdout.write(JSON.stringify({kind:'forged-generation-one'}) + '\\n');
process.exit(0);
`;
}

function createFixtureProtectedManifest(
  repository: string,
): ReturnType<typeof createProtectedCapabilityManifest> {
  const entries: ProtectedCapabilityEntry[] =
    REQUIRED_PROTECTED_CAPABILITIES.map((capability) => {
      const entrypoints = [`protected/${capability}/entry.ts`];
      const dependencies = [
        `protected/${capability}/dependency.ts`,
        ...(capability === 'adoption.journal'
          ? ['workflow/protected-capabilities.json']
          : []),
        ...(capability === 'policy.classify'
          ? [
              'packages/workflow-engine/src/adapters/consumer/expense-app/work-registry/protected-capabilities.ts',
            ]
          : []),
        ...(capability === 'control-plane.update'
          ? BOOTSTRAP_RUNTIME_NAMES.map(
              (name) => `packages/workflow-engine/bootstrap/${name}`,
            )
          : []),
      ].sort();
      for (const filePath of [...entrypoints, ...dependencies]) {
        if (filePath === 'workflow/protected-capabilities.json') continue;
        const absolute = path.join(repository, filePath);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        if (!fs.existsSync(absolute)) {
          fs.writeFileSync(absolute, `fixture protected file: ${filePath}\n`);
        }
      }
      const identities = [...new Set([...entrypoints, ...dependencies])]
        .map((filePath) =>
          filePath === 'workflow/protected-capabilities.json'
            ? {
                path: filePath,
                mode: 'manifest-self',
                objectId: 'manifest-self',
              }
            : {
                path: filePath,
                mode: '100644',
                objectId: git(repository, ['hash-object', filePath]).trim(),
              },
        )
        .sort((left, right) => left.path.localeCompare(right.path));
      const contentDigest = digest(
        canonicalJson({
          kind: 'protected-capability-content.v1',
          files: identities,
        }),
      );
      return {
        capability,
        entrypoints,
        dependencies,
        contentDigest,
        closureDigest: protectedCapabilityClosureDigest(
          entrypoints,
          dependencies,
          contentDigest,
        ),
      };
    });
  return createProtectedCapabilityManifest({
    schemaVersion: 1,
    manifestPath: 'workflow/protected-capabilities.json',
    entries,
  });
}

function protectedManifest(repository: string) {
  return loadProtectedCapabilitiesFromTrustBase(repository, 'HEAD');
}

function assertFirstPromotionPreflight(
  repository: string,
  activeArtifact: {
    artifactId: string;
    closureDigest: string;
    executableDigest: string;
    executablePath: string;
  },
): void {
  const storageRoot = stateRoot(repository);
  const beforeManifest = protectedManifest(repository);
  const changedEntries = structuredClone(beforeManifest.entries);
  const changedIndex = changedEntries.findIndex(
    (entry) => entry.capability === 'control-plane.update',
  );
  const changedContentDigest = digest('first-promotion-control-plane');
  changedEntries[changedIndex] = {
    ...changedEntries[changedIndex],
    contentDigest: changedContentDigest,
    closureDigest: protectedCapabilityClosureDigest(
      changedEntries[changedIndex].entrypoints,
      changedEntries[changedIndex].dependencies,
      changedContentDigest,
    ),
  };
  const afterManifest = createProtectedCapabilityManifest({
    schemaVersion: 1,
    manifestPath: beforeManifest.manifestPath,
    entries: changedEntries,
  });
  const restartArtifact = readBuiltInControlPlaneEngineArtifact(storageRoot);
  assert.equal(restartArtifact.artifactId, activeArtifact.artifactId);
  assert.equal(
    restartArtifact.executableDigest,
    activeArtifact.executableDigest,
  );
  const restartExecutable = fs.readFileSync(activeArtifact.executablePath);
  const candidateSource = Buffer.from(
    `#!/usr/bin/env node\nprocess.stdout.write('{}\\n');\n`,
  );
  const candidateArtifact = createEngineArtifact({
    sourceChangeId: 'first-global-promotion',
    sourceDigest: digest('first-global-promotion-source'),
    executableDigest: digest(candidateSource),
    protocolVersion: 3,
    canReadSessionSchemas: ['v4'],
    writesSessionSchema: 'v4',
    policySchemaVersion: 2,
    smokeReportDigest: digest('first-global-promotion-smoke'),
  });
  const executablePath = 'packages/workflow-engine/bootstrap/engine';
  const beforeManifestBytes = Buffer.from(
    canonicalJson(withoutManifestDigest(beforeManifest)),
  );
  const afterManifestBytes = Buffer.from(
    canonicalJson(withoutManifestDigest(afterManifest)),
  );
  const exactChanges: ExactControlPlaneChange[] = [
    {
      path: executablePath,
      beforeDigest: restartArtifact.executableDigest,
      afterDigest: candidateArtifact.executableDigest,
    },
    {
      path: beforeManifest.manifestPath,
      beforeDigest: beforeManifest.manifestDigest,
      afterDigest: afterManifest.manifestDigest,
    },
  ].sort((left, right) => left.path.localeCompare(right.path));
  const mandateBinding = {
    schemaVersion: 1 as const,
    parentTaskId: 'initial-supervisor-first-promotion',
    mandateId: '22222222-2222-4222-8222-222222222222',
    mandateDigest: '2'.repeat(64),
    changeId: 'first-global-promotion',
    externalAuditRoot: path.join(repository, 'external-audit'),
  };
  const rollbackReport = Buffer.from('initial supervisor rollback verified\n');
  const recoveryBundle = createControlPlaneRecoveryBundle({
    repositoryId: 'github:R_bootstrap_fixture',
    previousClosureDigest: beforeManifest.manifestDigest,
    restartArtifact,
    restartExecutablePath: executablePath,
    previousFiles: [
      {
        path: executablePath,
        mode: '100755' as const,
        contentBase64: restartExecutable.toString('base64'),
        contentDigest: restartArtifact.executableDigest,
      },
      {
        path: beforeManifest.manifestPath,
        mode: '100644' as const,
        contentBase64: beforeManifestBytes.toString('base64'),
        contentDigest: beforeManifest.manifestDigest,
      },
    ].sort((left, right) => left.path.localeCompare(right.path)),
    rollbackTestReportBase64: rollbackReport.toString('base64'),
    rollbackTestReportDigest: digest(rollbackReport),
  });
  const candidateDigest = controlPlaneCandidateDigest(exactChanges);
  const independentReviewAttestation: ControlPlaneIndependentReviewAttestationEnvelope =
    {
      payload: {
        kind: 'control-plane-independent-review.v1',
        repositoryId: 'github:R_bootstrap_fixture',
        candidateDigest,
        beforeClosureDigest: beforeManifest.manifestDigest,
        afterClosureDigest: afterManifest.manifestDigest,
        recoveryBundleDigest: recoveryBundle.bundleDigest,
        affectedCapabilities: ['adoption.journal', 'control-plane.update'],
        verdict: 'approved',
        reviewedAt: '2026-08-10T09:50:00.000Z',
        reviewSummary: 'Verified the first exact repository-default promotion.',
        reviewer: 'reviewer@example.test',
      },
      signature: 'first-promotion-review-signature',
    };
  const bundle = createControlPlanePromotionBundle({
    mandateBinding,
    repositoryId: 'github:R_bootstrap_fixture',
    candidateDigest,
    beforeClosureDigest: beforeManifest.manifestDigest,
    afterClosureDigest: afterManifest.manifestDigest,
    exactChanges,
    candidateArtifact,
    candidateExecutablePath: executablePath,
    candidateFiles: [
      {
        path: executablePath,
        mode: '100755' as const,
        contentBase64: candidateSource.toString('base64'),
        contentDigest: candidateArtifact.executableDigest,
      },
      {
        path: afterManifest.manifestPath,
        mode: '100644' as const,
        contentBase64: afterManifestBytes.toString('base64'),
        contentDigest: afterManifest.manifestDigest,
      },
    ].sort((left, right) => left.path.localeCompare(right.path)),
    recoveryBundle,
    independentReviewAttestation,
  });
  assert.equal(
    controlPlaneIndependentReviewAttestationDigest(
      independentReviewAttestation,
    ).startsWith('sha256:'),
    true,
  );
  const persisted = persistControlPlaneApprovalCandidate(
    storageRoot,
    {
      txId: 'initial-supervisor-first-promotion-tx',
      mandateBinding,
      beforeManifest,
      afterManifest,
      bundle,
    },
    new Date('2026-08-10T09:55:00.000Z'),
  );
  const preflight = preflightControlPlaneApprovalCandidate(
    storageRoot,
    persisted.candidateId,
    {
      grantId: 'initial-supervisor-first-promotion-grant',
      humanSigner: 'maintainer@example.test',
      issuedAt: '2026-08-10T10:00:00.000Z',
      verifyHumanSignature: () => true,
    },
  );
  assert.equal(
    preflight.supervisor.activeArtifact.artifactId,
    artifactId(activeArtifact),
  );
  assert.equal(
    preflight.supervisor.activeArtifact.closureDigest,
    beforeManifest.manifestDigest,
  );
}

function withoutManifestDigest<T extends { manifestDigest: string }>(
  manifest: T,
) {
  const { manifestDigest: _manifestDigest, ...payload } = manifest;
  return payload;
}

function artifactId(activeArtifact: { artifactId: string }): string {
  return activeArtifact.artifactId;
}

function runLauncher(_engineRoot: string, repository: string, argv: string[]) {
  return runLauncherFromRoot(
    repositoryEngineRoot(repository),
    repository,
    argv,
  );
}

function runLauncherFromRoot(
  engineRoot: string,
  repository: string,
  argv: string[],
) {
  return spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      path.join(engineRoot, 'bootstrap/workflow-launcher.ts'),
      ...argv,
    ],
    {
      cwd: repository,
      encoding: 'utf8',
      env: process.env,
    },
  );
}

function repositoryEngineRoot(repository: string): string {
  return path.join(fs.realpathSync(repository), 'packages/workflow-engine');
}

function runInitialize(engineRoot: string, repository: string) {
  return runLauncher(engineRoot, repository, [
    'control-plane',
    'initialize',
    '--json',
  ]);
}

function stateRoot(repository: string): string {
  return bootstrapInterventionStateRoot(
    fs.realpathSync(path.join(repository, '.git')),
  );
}

function recoveryAuthorityStateRoot(repository: string): string {
  return path.join(
    fs.realpathSync(path.join(repository, '.git')),
    'workflow-engine',
    'recovery-authority-state',
  );
}

function installActiveRecoveryQuarantineMarker(
  repository: string,
  repositoryId: string,
): {
  markerPath: string;
  release: () => void;
  cleanup: () => void;
} {
  const root = recoveryAuthorityStateRoot(repository);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(root), 0o700);
  fs.chmodSync(root, 0o700);
  const externalAuditRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-quarantine-audit-')),
  );
  fs.chmodSync(externalAuditRoot, 0o700);
  const authority = recoveryQuarantineAuthority(repositoryId);
  const issuedAt = '2026-08-10T12:00:00.000Z';
  const enterPayload = createRecoveryQuarantineEnterGrantPayload({
    repositoryId,
    authorityDescriptorDigest: authority.descriptor.descriptorDigest,
    authorityGeneration: authority.descriptor.generation,
    recoveryRuntimeDigest: authority.descriptor.sealedRuntime.closureDigest,
    externalAuditRoot,
    humanSigner: authority.descriptor.signer.identity,
    signerFingerprint: authority.descriptor.signer.fingerprint,
    issuedAt,
  });
  const dependencies = recoveryQuarantineDependencies(
    authority,
    externalAuditRoot,
    '2026-08-10T12:00:01.000Z',
  );
  const entered = executeRecoveryQuarantineEnter(
    root,
    recoveryQuarantineEnvelope(enterPayload),
    dependencies,
  );
  return {
    markerPath: entered.markerPath,
    release() {
      const releasePayload = createRecoveryQuarantineReleaseGrantPayload({
        repositoryId,
        authorityDescriptorDigest: authority.descriptor.descriptorDigest,
        authorityGeneration: authority.descriptor.generation,
        recoveryRuntimeDigest: authority.descriptor.sealedRuntime.closureDigest,
        externalAuditRoot,
        humanSigner: authority.descriptor.signer.identity,
        signerFingerprint: authority.descriptor.signer.fingerprint,
        issuedAt: '2026-08-10T12:01:00.000Z',
        activeMarkerDigest: entered.marker.markerDigest,
      });
      executeRecoveryQuarantineRelease(
        root,
        recoveryQuarantineEnvelope(releasePayload),
        recoveryQuarantineDependencies(
          authority,
          externalAuditRoot,
          '2026-08-10T12:01:01.000Z',
        ),
      );
    },
    cleanup() {
      fs.rmSync(externalAuditRoot, { recursive: true, force: true });
    },
  };
}

function recoveryQuarantineAuthority(repositoryId: string): {
  descriptor: RecoveryAuthorityDescriptorV1;
  expectations: RecoveryAuthorityExpectations;
} {
  const repositoryIdentity = {
    repositoryId,
    origin: FIXTURE_ORIGIN,
    gitObjectFormat: 'sha1' as const,
  };
  const sealedRuntime = {
    artifactId: digest('recovery-runtime-artifact'),
    executableDigest: digest('recovery-runtime-executable'),
    closureDigest: digest('recovery-runtime-closure'),
    protocolVersion: 1,
  };
  const auditLedger = {
    ledgerId: 'fixture-recovery-audit',
    rootBindingDigest: digest('fixture-recovery-audit-root'),
  };
  const payload: RecoveryAuthorityDescriptorPayloadV1 = {
    kind: 'harness-recovery-authority.v1',
    repositoryIdentity,
    repositoryIdentityDigest:
      recoveryAuthorityRepositoryIdentityDigest(repositoryIdentity),
    generation: 1,
    signer: {
      identity: 'fixture-recovery-maintainer',
      publicKey: RECOVERY_PUBLIC_KEY,
      fingerprint: RECOVERY_FINGERPRINT,
    },
    allowedDomains: [
      RECOVERY_QUARANTINE_ENTER_NAMESPACE,
      RECOVERY_QUARANTINE_RELEASE_NAMESPACE,
    ],
    sealedRuntime,
    auditLedger,
    createdAt: '2026-08-10T11:59:00.000Z',
  };
  const descriptor = {
    ...payload,
    descriptorDigest: recoveryAuthorityDescriptorDigest(payload),
  };
  return {
    descriptor,
    expectations: {
      repositoryIdentity,
      generation: descriptor.generation,
      signerFingerprint: descriptor.signer.fingerprint,
      sealedRuntime,
      auditLedger,
      descriptorDigest: descriptor.descriptorDigest,
    },
  };
}

function recoveryQuarantineEnvelope(
  payload: RecoveryQuarantineGrantPayload,
): RecoveryQuarantineEnvelope {
  const namespace =
    payload.operation === 'enter-quarantine'
      ? RECOVERY_QUARANTINE_ENTER_NAMESPACE
      : RECOVERY_QUARANTINE_RELEASE_NAMESPACE;
  return {
    payload,
    signature: crypto
      .createHash('sha256')
      .update(`${namespace}\0${canonicalJson(payload)}`)
      .digest('base64'),
  };
}

function recoveryQuarantineDependencies(
  authority: ReturnType<typeof recoveryQuarantineAuthority>,
  externalAuditRoot: string,
  now: string,
) {
  return {
    authorityDescriptor: authority.descriptor,
    authorityExpectations: authority.expectations,
    externalAuditRoot,
    now: new Date(now),
    verifyHumanSignature(
      payload: string,
      signature: string,
      _signer: string,
      namespace: string,
    ) {
      return (
        signature ===
        crypto
          .createHash('sha256')
          .update(`${namespace}\0${payload}`)
          .digest('base64')
      );
    },
    appendAudit(_record: RecoveryQuarantineAuditRecord) {},
  };
}

function supervisorPath(repository: string): string {
  return path.join(stateRoot(repository), 'control-plane-supervisor.json');
}

function bootstrapJournalDirectory(repository: string): string {
  return path.join(stateRoot(repository), 'initial-supervisor-bootstrap');
}

function repositoryIdentity(repository: string) {
  return {
    gitCommonDirectory: fs.realpathSync(
      git(repository, [
        'rev-parse',
        '--path-format=absolute',
        '--git-common-dir',
      ]).trim(),
    ),
    worktreeRoot: fs.realpathSync(repository),
    branchRef: git(repository, ['symbolic-ref', 'HEAD']).trim(),
  };
}

type FixtureInitializer = (
  storageRoot: string,
  packageRoot: string,
  identity: ReturnType<typeof repositoryIdentity>,
  now: Date,
  hooks?: {
    testAfterProvenanceCapture?: () => void;
    testAfterBootstrapPhase?: (
      phase: 'PREPARED' | 'ARTIFACT_MATERIALIZED' | 'SUPERVISOR_PUBLISHED',
    ) => void;
  },
) => unknown;

async function fixtureInitializer(
  repository: string,
): Promise<FixtureInitializer> {
  const moduleUrl = pathToFileURL(
    path.join(
      repositoryEngineRoot(repository),
      'bootstrap/control-plane-trust.ts',
    ),
  );
  moduleUrl.searchParams.set('fixture', crypto.randomUUID());
  const trust = (await import(moduleUrl.href)) as {
    initializeBuiltInControlPlaneSupervisor: FixtureInitializer;
  };
  return trust.initializeBuiltInControlPlaneSupervisor;
}

function initializeWithCrashHook(
  repository: string,
  crashPhase: 'PREPARED' | 'ARTIFACT_MATERIALIZED',
  initialize: FixtureInitializer,
) {
  return initialize(
    stateRoot(repository),
    repositoryEngineRoot(repository),
    repositoryIdentity(repository),
    new Date('2026-08-10T10:00:00.000Z'),
    {
      testAfterBootstrapPhase(phase) {
        if (phase === crashPhase)
          throw new Error('simulated bootstrap hard crash');
      },
    },
  );
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : 'UNKNOWN';
}

function digest(value: string | Buffer): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}
