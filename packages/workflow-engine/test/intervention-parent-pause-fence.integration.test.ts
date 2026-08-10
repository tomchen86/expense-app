import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  capturePersistedWipIntervention,
  executePersistedAdoptionStep,
  initializeLocalEngineBinding,
  materializeInterventionChildWorktree,
} from '../src/intervention-control-bootstrap.ts';
import { canonicalJson } from '../src/canonical-json.ts';
import { createEngineArtifact } from '../src/intervention-control.ts';
import { preparePersistedEngineAdoption } from '../src/intervention-control-persistence.ts';
import { persistInterventionEngineArtifact } from '../src/intervention-maintenance.ts';
import { setupFinalizedControlPlanePromotionFixture } from './control-plane-promotion-fixture.ts';

const NOW = new Date('2026-08-09T10:00:00.000Z');
const SOURCE_REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../../..');
const WORKFLOW_LAUNCHER = path.join(
  SOURCE_REPOSITORY_ROOT,
  'packages',
  'workflow-engine',
  'bootstrap',
  'workflow-launcher.ts',
);

function digest(value: string | Buffer): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function git(repository: string, args: string[]): string {
  return childProcess.execFileSync('git', ['-C', repository, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function dependencies(now = NOW) {
  return {
    now: () => now,
    verifyHumanSignature(
      _payload: string,
      signature: string,
      _signer: string,
      namespace: string,
    ) {
      assert.equal(signature, 'parent-fence-human-signature');
      assert.equal(namespace, 'expense-app.harness-maintenance-grant.v1');
      return true;
    },
  };
}

async function fixture(healthy: boolean) {
  const controlPlane = await setupFinalizedControlPlanePromotionFixture();
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'intervention-parent-fence-')),
  );
  fs.chmodSync(root, 0o700);
  const repository = fs.realpathSync(controlPlane.repository);
  const child = path.join(
    path.dirname(repository),
    `${path.basename(repository)}-parent-fence-child-${crypto.randomUUID()}`,
  );
  const localLaunchMarker = path.join(root, 'local-engine-started');
  const stateRoot = controlPlane.stateRoot;
  const globalArtifact = installTerminalV2RollbackFixture(controlPlane);
  git(repository, ['checkout', '-b', 'work/parent-A']);

  const sessionSnapshotPath = path.join(stateRoot, 'parent-session.json');
  fs.writeFileSync(sessionSnapshotPath, '{"step":"P1"}\n', { mode: 0o600 });
  const captured = capturePersistedWipIntervention(stateRoot, {
    repositoryRoot: repository,
    parent: {
      changeId: 'parent-A',
      status: 'active',
      engineBinding: globalArtifact.executableDigest,
      sessionSchema: 'v4',
      blocker: null,
    },
    interventionChangeId: 'intervention-B',
    childWorkspacePath: child,
    changeRef: 'refs/heads/work/intervention-B',
    untrackedAllowlist: [],
    sessionSnapshotPath,
    pendingIntent: 'Resume parent-A only after the repair is adopted.',
    policyDigest: digest('parent-fence-policy'),
    now: NOW,
  });

  const envelope = {
    payload: {
      kind: 'harness-maintenance-grant.v1' as const,
      grantId: `parent-fence-${healthy ? 'healthy' : 'rollback'}`,
      parentChangeId: 'parent-A',
      interventionChangeId: 'intervention-B',
      scope: {
        paths: ['packages/harness-runtime/**', 'packages/workflow-engine/**'],
        operations: [
          'adopt-engine-into-parent' as const,
          'build-engine-artifact' as const,
          'create-isolated-workspace' as const,
          'modify-engine' as const,
          'run-engine-tests' as const,
        ],
      },
      waivers: [
        'active-change-exclusivity' as const,
        'clean-worktree-required' as const,
        'engine-path-protection' as const,
      ],
      engineFromDigest: globalArtifact.executableDigest,
      sessionSchema: 'v4',
      maxLocalAdoptions: 1,
      issuedAt: '2026-08-09T09:55:00.000Z',
      expiresAt: '2026-08-09T11:00:00.000Z',
      humanSigner: 'maintainer@example.test',
      reason: 'Repair the blocked parent under a durable fence.',
    },
    signature: 'parent-fence-human-signature',
  };

  let journalDigest: `sha256:${string}` | null = null;
  let artifact: ReturnType<typeof createEngineArtifact> | null = null;
  let executablePath: string | null = null;
  const txId = `parent-fence-${healthy ? 'healthy' : 'rollback'}-tx`;
  const bindingPath = parentBindingPath(stateRoot, 'parent-A');

  return {
    root,
    repository,
    stateRoot,
    txId,
    localLaunchMarker,
    checkpointId: captured.intervention.checkpoint.checkpointId,
    prepareAdoption() {
      materializeInterventionChildWorktree(
        stateRoot,
        {
          parentChangeId: 'parent-A',
          repositoryRoot: repository,
          maintenanceGrantEnvelope: envelope,
        },
        dependencies(),
      );
      executablePath = path.join(child, 'engine-probe.mjs');
      const source = localEngineSource(healthy, localLaunchMarker);
      fs.writeFileSync(executablePath, source, { mode: 0o755 });
      artifact = createEngineArtifact({
        sourceChangeId: 'intervention-B',
        sourceDigest: digest(`parent-fence-local-source:${healthy}`),
        executableDigest: digest(source),
        protocolVersion: 3,
        canReadSessionSchemas: ['v4'],
        writesSessionSchema: 'v4',
        policySchemaVersion: 2,
        smokeReportDigest: digest(`parent-fence-local-smoke:${healthy}`),
      });
      persistInterventionEngineArtifact(stateRoot, {
        parentChangeId: 'parent-A',
        artifact,
        executablePath,
        now: NOW,
      });
      const adoption = preparePersistedEngineAdoption(
        stateRoot,
        {
          txId,
          parentChangeId: 'parent-A',
          artifact,
          maintenanceGrantEnvelope: envelope,
          priorLocalAdoptions: 0,
        },
        dependencies(),
      );
      journalDigest = adoption.journal.journalDigest;
      initializeLocalEngineBinding(stateRoot, bindingPath, {
        parentChangeId: 'parent-A',
        parentWorkspacePath: repository,
        parentBranch: 'refs/heads/work/parent-A',
        interventionChangeId: 'intervention-B',
        txId,
        checkpointId: captured.intervention.checkpoint.checkpointId,
        engineDigest: globalArtifact.executableDigest,
        artifactId: artifact.artifactId,
        executableDigest: artifact.executableDigest,
        executablePath: path.join(
          stateRoot,
          'local-engine-artifacts',
          artifact.artifactId.slice('sha256:'.length),
          'engine',
        ),
        sessionSchema: 'v4',
        now: NOW,
      });
    },
    step(index: number) {
      assert.notEqual(journalDigest, null);
      assert.notEqual(artifact, null);
      assert.notEqual(executablePath, null);
      const at = new Date(NOW.getTime() + (index + 1) * 60_000).toISOString();
      const result = executePersistedAdoptionStep(
        stateRoot,
        {
          txId,
          expectedJournalDigest: journalDigest!,
          bindingPath,
          artifact: artifact!,
          executablePath: executablePath!,
          at,
        },
        dependencies(new Date(at)),
      );
      journalDigest = result.record.journal.journalDigest;
      return result;
    },
    completeAdoption() {
      let result: ReturnType<typeof executePersistedAdoptionStep> | undefined;
      for (let index = 0; index < 5; index += 1) result = this.step(index);
      return result!;
    },
    cleanup() {
      controlPlane.cleanup();
      fs.rmSync(child, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

type FinalizedControlPlaneFixture = Awaited<
  ReturnType<typeof setupFinalizedControlPlanePromotionFixture>
>;

function installTerminalV2RollbackFixture(
  fixture: FinalizedControlPlaneFixture,
): { executableDigest: `sha256:${string}` } {
  const bundle = readPrivateRecord(
    onlyPrivateJsonFile(
      path.join(fixture.stateRoot, 'control-plane-promotion-bundles'),
    ),
  );
  const material = requireRecordField(bundle, 'material');
  const recovery = requireRecordField(material, 'recoveryBundle');
  const restartArtifact = requireRecordField(recovery, 'restartArtifact');

  const updatePath = onlyPrivateJsonFile(
    path.join(fixture.stateRoot, 'control-updates'),
  );
  const update = readPrivateRecord(updatePath);
  const transaction = requireRecordField(update, 'transaction');
  assert.equal(Array.isArray(transaction.history), true);
  assert.equal(Array.isArray(update.observations), true);
  const history = transaction.history as Array<Record<string, unknown>>;
  const observations = update.observations as Array<Record<string, unknown>>;
  history.at(-2)!.state = 'ROLLBACK_REQUIRED';
  history.at(-1)!.state = 'ROLLED_BACK';
  observations.at(-2)!.toState = 'ROLLBACK_REQUIRED';
  observations.at(-2)!.eventKind = 'self-tests-failed';
  observations.at(-1)!.fromState = 'ROLLBACK_REQUIRED';
  observations.at(-1)!.toState = 'ROLLED_BACK';
  observations.at(-1)!.eventKind = 'rollback-completed';
  transaction.state = 'ROLLED_BACK';
  transaction.journalDigest = recomputeDigest(transaction, 'journalDigest');
  update.recordDigest = recomputeDigest(update, 'recordDigest');
  writePrivateRecord(updatePath, update);

  const supervisorPath = path.join(
    fixture.stateRoot,
    'control-plane-supervisor.json',
  );
  const supervisor = readPrivateRecord(supervisorPath);
  const artifactId = exactDigest(restartArtifact.artifactId);
  const executableDigest = exactDigest(restartArtifact.executableDigest);
  supervisor.generation = 3;
  supervisor.activeArtifact = {
    artifactId,
    executableDigest,
    closureDigest: exactDigest(transaction.beforeClosureDigest),
    executablePath: path.join(
      fixture.stateRoot,
      'control-plane-artifacts',
      artifactId.slice('sha256:'.length),
      'engine',
    ),
  };
  const transition = requireRecordField(supervisor, 'transition');
  transition.phase = 'rollback-restored';
  supervisor.recordDigest = recomputeDigest(supervisor, 'recordDigest');
  writePrivateRecord(supervisorPath, supervisor);
  return { executableDigest };
}

function onlyPrivateJsonFile(directory: string): string {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.isFile(), true);
  assert.equal(entries[0]?.isSymbolicLink(), false);
  assert.match(entries[0]?.name ?? '', /^[0-9a-f]{64}\.json$/);
  return path.join(directory, entries[0]!.name);
}

function readPrivateRecord(filePath: string): Record<string, unknown> {
  const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  assert.equal(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    true,
  );
  return value as Record<string, unknown>;
}

function requireRecordField(
  value: Record<string, unknown>,
  field: string,
): Record<string, unknown> {
  const fieldValue = value[field];
  assert.equal(
    typeof fieldValue === 'object' &&
      fieldValue !== null &&
      !Array.isArray(fieldValue),
    true,
  );
  return fieldValue as Record<string, unknown>;
}

function recomputeDigest(
  value: Record<string, unknown>,
  field: string,
): `sha256:${string}` {
  const payload = { ...value };
  delete payload[field];
  return digest(canonicalJson(payload));
}

function writePrivateRecord(
  filePath: string,
  value: Record<string, unknown>,
): void {
  fs.writeFileSync(filePath, `${canonicalJson(value)}\n`, { mode: 0o600 });
}

function exactDigest(value: unknown): `sha256:${string}` {
  assert.equal(
    typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value),
    true,
  );
  return value as `sha256:${string}`;
}

test('durable intervention fence blocks before E1/E2 and routes sealed status and recovery', async () => {
  const value = await fixture(true);
  try {
    const blockedInitialization = runWorkflowLauncher(value.repository, [
      'control-plane',
      'initialize',
      '--json',
    ]);
    assert.notEqual(blockedInitialization.status, 0);
    assert.equal(blockedInitialization.stdout, '');
    assert.match(
      blockedInitialization.stderr,
      /WORKFLOW_PARENT_INTERVENTION_BLOCKED/,
    );

    const blockedBeforeAdoption = runWorkflowLauncher(value.repository, [
      'finish',
      'parent-session-id',
    ]);
    assert.notEqual(blockedBeforeAdoption.status, 0);
    assert.equal(blockedBeforeAdoption.stdout, '');
    assert.match(
      blockedBeforeAdoption.stderr,
      /WORKFLOW_PARENT_INTERVENTION_BLOCKED/,
    );

    const status = runWorkflowLauncher(value.repository, [
      'intervention',
      'status',
      'parent-A',
      '--json',
    ]);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).result.action, 'status');

    for (const malformed of [
      ['status'],
      ['status', '--json'],
      ['status', 'parent-session-id', '--json', '--extra'],
    ]) {
      const rejected = runWorkflowLauncher(value.repository, malformed);
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /WORKFLOW_PARENT_INTERVENTION_BLOCKED/);
    }
    const ordinaryStatus = runWorkflowLauncher(value.repository, [
      'status',
      'parent-session-id',
      '--json',
    ]);
    assert.equal(ordinaryStatus.status, 0, ordinaryStatus.stderr);
    assert.match(ordinaryStatus.stdout, /fixture built-in engine/);

    value.prepareAdoption();
    value.step(0);
    const recovery = runWorkflowLauncher(value.repository, [
      'intervention',
      'recover',
      value.txId,
      '--json',
    ]);
    assert.equal(recovery.status, 0, recovery.stderr);
    assert.equal(JSON.parse(recovery.stdout).result.action, 'recover');
    assert.equal(
      JSON.parse(recovery.stdout).result.adoptionState,
      'PARENT_CHECKPOINTED',
    );

    const incompleteStatus = runWorkflowLauncher(value.repository, [
      'status',
      'parent-session-id',
    ]);
    assert.equal(incompleteStatus.status, 0, incompleteStatus.stderr);
    assert.match(incompleteStatus.stdout, /fixture built-in engine/);

    const incompleteOrdinary = runWorkflowLauncher(value.repository, [
      'check',
      'parent-session-id',
    ]);
    assert.notEqual(incompleteOrdinary.status, 0);
    assert.equal(incompleteOrdinary.stdout, '');

    const committed = value.completeAdoption();
    assert.equal(committed.record.journal.state, 'COMMITTED');
    const resumed = runWorkflowLauncher(value.repository, [
      'status',
      'parent-session-id',
    ]);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(JSON.parse(resumed.stdout).engine, 'E2');
    assert.equal(fs.existsSync(value.localLaunchMarker), true);
  } finally {
    value.cleanup();
  }
});

test('rolled-back adoption retains the parent fence before repository-default launch', async () => {
  const value = await fixture(false);
  try {
    value.prepareAdoption();
    const rolledBack = value.completeAdoption();
    assert.equal(rolledBack.record.journal.state, 'ENGINE_BINDING_ROLLED_BACK');
    const blocked = runWorkflowLauncher(value.repository, [
      'complete-task',
      'parent-session-id',
    ]);
    assert.notEqual(blocked.status, 0);
    assert.equal(blocked.stdout, '');
    assert.match(blocked.stderr, /WORKFLOW_PARENT_INTERVENTION_BLOCKED/);
    assert.equal(fs.existsSync(value.localLaunchMarker), false);

    const status = runWorkflowLauncher(value.repository, [
      'status',
      'parent-session-id',
      '--json',
    ]);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /fixture built-in engine/);
  } finally {
    value.cleanup();
  }
});

function localEngineSource(healthy: boolean, launchMarker: string): string {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const mode = process.argv[2];
if (mode === '--bootstrap-probe') {
  process.stdout.write(JSON.stringify({kind:'engine-bootstrap-probe.v1',started:true,sessionSchema:'v4'}) + '\\n');
  process.exit(0);
}
if (mode === '--health-check') {
  process.stdout.write(JSON.stringify({kind:'engine-health.v1',healthy:${healthy ? 'true' : 'false'},sessionSchema:'v4'}) + '\\n');
  process.exit(0);
}
fs.appendFileSync(${JSON.stringify(launchMarker)}, process.argv.slice(2).join(' ') + '\\n');
process.stdout.write(JSON.stringify({kind:'local-adopted-engine.v1',engine:'E2',argv:process.argv.slice(2)}) + '\\n');
process.exit(0);
`;
}

function runWorkflowLauncher(repository: string, argv: string[]) {
  return childProcess.spawnSync(
    process.execPath,
    ['--experimental-strip-types', WORKFLOW_LAUNCHER, ...argv],
    { cwd: repository, encoding: 'utf8', env: process.env },
  );
}

function parentBindingPath(stateRoot: string, parentChangeId: string): string {
  const identity = crypto
    .createHash('sha256')
    .update(`parent-session\0${parentChangeId}`)
    .digest('hex');
  return path.join(stateRoot, 'local-parent-sessions', `${identity}.json`);
}
