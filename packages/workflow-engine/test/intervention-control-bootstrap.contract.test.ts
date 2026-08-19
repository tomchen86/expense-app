import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  capturePersistedWipIntervention,
  executePersistedAdoptionStep,
  initializeLocalEngineBinding,
  localEngineArtifactPath,
  materializeInterventionChildWorktree,
  readLocalEngineBinding,
  readPersistedWipBundle,
  restorePersistedWipBundle,
} from '../src/application/control-plane/intervention-control-bootstrap.ts';
import { createEngineArtifact } from '../src/modules/authority/intervention-control.ts';
import { persistInterventionEngineArtifact } from '../src/application/control-plane/intervention-maintenance.ts';
import { preparePersistedEngineAdoption } from '../src/intervention-control-persistence.ts';
import { WorkflowError } from '../src/foundation/errors/errors.ts';

const NOW = new Date('2026-08-03T10:00:00.000Z');

function digest(label: string | Buffer): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(label).digest('hex')}`;
}

function hasCode(code: string) {
  return (error: unknown): boolean =>
    error instanceof WorkflowError && error.code === code;
}

function git(repository: string, args: string[]): string {
  return execFileSync('git', ['-C', repository, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function fixtureRepository() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'intervention-bootstrap-')),
  );
  fs.chmodSync(root, 0o700);
  const repository = path.join(root, 'parent');
  const child = path.join(root, 'child');
  const stateRoot = path.join(root, 'state');
  const sessionPath = path.join(stateRoot, 'session.json');
  const bindingPath = path.join(stateRoot, 'engine-binding.json');
  fs.mkdirSync(repository, { mode: 0o700 });
  fs.mkdirSync(stateRoot, { mode: 0o700 });
  git(repository, ['init', '-b', 'work/parent-A']);
  git(repository, ['config', 'user.email', 'workflow@example.test']);
  git(repository, ['config', 'user.name', 'Workflow Test']);
  fs.writeFileSync(path.join(repository, 'tracked.txt'), 'base\n');
  fs.writeFileSync(path.join(repository, 'README.md'), '# Fixture\n');
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'Create fixture baseline']);
  return {
    root,
    repository,
    child,
    stateRoot,
    sessionPath,
    bindingPath,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function createWip(fixture: ReturnType<typeof fixtureRepository>) {
  fs.writeFileSync(path.join(fixture.repository, 'tracked.txt'), 'staged\n');
  git(fixture.repository, ['add', 'tracked.txt']);
  fs.writeFileSync(
    path.join(fixture.repository, 'tracked.txt'),
    'staged-and-unstaged\n',
  );
  fs.writeFileSync(path.join(fixture.repository, 'added.txt'), 'staged-new\n');
  git(fixture.repository, ['add', 'added.txt']);
  fs.writeFileSync(
    path.join(fixture.repository, 'added.txt'),
    'staged-new-and-unstaged\n',
  );
  fs.mkdirSync(path.join(fixture.repository, 'notes'));
  fs.writeFileSync(
    path.join(fixture.repository, 'notes/allowed.txt'),
    Buffer.from([0, 1, 2, 3, 255]),
  );
  fs.writeFileSync(
    fixture.sessionPath,
    `${JSON.stringify({ step: 'pending', engine: 'E1' })}\n`,
    { mode: 0o600 },
  );
}

function capture(fixture: ReturnType<typeof fixtureRepository>) {
  return capturePersistedWipIntervention(fixture.stateRoot, {
    repositoryRoot: fixture.repository,
    parent: {
      changeId: 'parent-A',
      status: 'active',
      engineBinding: digest('engine-E1'),
      sessionSchema: 'v4',
      blocker: null,
    },
    interventionChangeId: 'intervention-B',
    childWorkspacePath: fixture.child,
    changeRef: 'refs/heads/work/intervention-B',
    untrackedAllowlist: ['notes/allowed.txt'],
    sessionSnapshotPath: fixture.sessionPath,
    pendingIntent: 'Resume parent-A after adopting the repaired engine.',
    policyDigest: digest('policy-E1'),
    now: NOW,
  });
}

function maintenanceEnvelope(engineFromDigest: `sha256:${string}`) {
  return {
    payload: {
      kind: 'harness-maintenance-grant.v1' as const,
      grantId: 'bootstrap-maintenance-1',
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
      engineFromDigest,
      sessionSchema: 'v4',
      maxLocalAdoptions: 1,
      issuedAt: '2026-08-03T09:55:00.000Z',
      expiresAt: '2026-08-03T11:00:00.000Z',
      humanSigner: 'maintainer@example.test',
      reason: 'Repair the parent through the bounded bootstrap intervention.',
    },
    signature: 'bootstrap-human-signature',
  };
}

function humanDependencies(now = NOW) {
  return {
    now: () => now,
    verifyHumanSignature(
      _payload: string,
      signature: string,
      _signer: string,
      namespace: string,
    ) {
      assert.equal(signature, 'bootstrap-human-signature');
      assert.equal(namespace, 'expense-app.harness-maintenance-grant.v1');
      return true;
    },
  };
}

test('bootstrap captures and restores tracked, staged, allowlisted untracked, and session bytes', () => {
  const fixture = fixtureRepository();
  try {
    createWip(fixture);
    const beforeStatus = git(fixture.repository, [
      'status',
      '--porcelain=v1',
      '-z',
    ]);
    const beforeTracked = fs.readFileSync(
      path.join(fixture.repository, 'tracked.txt'),
      'utf8',
    );
    const beforeAdded = fs.readFileSync(
      path.join(fixture.repository, 'added.txt'),
      'utf8',
    );
    const beforeUntracked = fs.readFileSync(
      path.join(fixture.repository, 'notes/allowed.txt'),
    );
    const beforeSession = fs.readFileSync(fixture.sessionPath);

    const captured = capture(fixture);
    assert.equal(captured.bundle.kind, 'harness-wip-bundle.v1');
    assert.equal(captured.intervention.parent.status, 'active');
    assert.equal(fs.existsSync(fixture.child), false);
    assert.deepEqual(
      readPersistedWipBundle(
        fixture.stateRoot,
        captured.intervention.checkpoint.checkpointId,
      ),
      captured.bundle,
    );

    git(fixture.repository, ['reset', '--hard', 'HEAD']);
    fs.rmSync(path.join(fixture.repository, 'notes'), {
      recursive: true,
      force: true,
    });
    fs.writeFileSync(fixture.sessionPath, '{"step":"lost"}\n');

    const envelope = maintenanceEnvelope(
      captured.intervention.parent.engineBinding,
    );
    const restored = restorePersistedWipBundle(
      fixture.stateRoot,
      {
        parentChangeId: 'parent-A',
        repositoryRoot: fixture.repository,
        sessionSnapshotPath: fixture.sessionPath,
        maintenanceGrantEnvelope: envelope,
      },
      humanDependencies(),
    );
    assert.equal(restored.effectsPerformed, true);
    assert.equal(
      fs.readFileSync(path.join(fixture.repository, 'tracked.txt'), 'utf8'),
      beforeTracked,
    );
    assert.equal(
      fs.readFileSync(path.join(fixture.repository, 'added.txt'), 'utf8'),
      beforeAdded,
    );
    assert.deepEqual(
      fs.readFileSync(path.join(fixture.repository, 'notes/allowed.txt')),
      beforeUntracked,
    );
    assert.deepEqual(fs.readFileSync(fixture.sessionPath), beforeSession);
    assert.equal(
      git(fixture.repository, ['status', '--porcelain=v1', '-z']),
      beforeStatus,
    );
    assert.notEqual(git(fixture.repository, ['diff', '--cached']), '');
    assert.notEqual(git(fixture.repository, ['diff']), '');
  } finally {
    fixture.cleanup();
  }
});

test('capture rejects unallowlisted untracked evidence and restore requires human grant', () => {
  const fixture = fixtureRepository();
  try {
    createWip(fixture);
    fs.writeFileSync(
      path.join(fixture.repository, 'secret.txt'),
      'not allowed',
    );
    assert.throws(
      () => capture(fixture),
      hasCode('BOOTSTRAP_UNTRACKED_ALLOWLIST_MISMATCH'),
    );
    fs.unlinkSync(path.join(fixture.repository, 'secret.txt'));
    const captured = capture(fixture);
    git(fixture.repository, ['reset', '--hard', 'HEAD']);
    fs.rmSync(path.join(fixture.repository, 'notes'), {
      recursive: true,
      force: true,
    });
    assert.throws(
      () =>
        restorePersistedWipBundle(
          fixture.stateRoot,
          {
            parentChangeId: 'parent-A',
            repositoryRoot: fixture.repository,
            sessionSnapshotPath: fixture.sessionPath,
            maintenanceGrantEnvelope: maintenanceEnvelope(
              captured.intervention.parent.engineBinding,
            ),
          },
          { now: () => NOW },
        ),
      hasCode('BOOTSTRAP_HUMAN_VERIFIER_REQUIRED'),
    );
  } finally {
    fixture.cleanup();
  }
});

function writeEngineExecutable(
  childWorkspace: string,
  healthy: boolean,
): { executablePath: string; executableDigest: `sha256:${string}` } {
  const executablePath = path.join(childWorkspace, 'engine-probe.mjs');
  const source = `#!/usr/bin/env node
const mode = process.argv[2];
if (mode === '--bootstrap-probe') {
  process.stdout.write(JSON.stringify({kind:'engine-bootstrap-probe.v1',started:true,sessionSchema:'v4'}) + '\\n');
  process.exit(0);
}
if (mode === '--health-check') {
  process.stdout.write(JSON.stringify({kind:'engine-health.v1',healthy:${healthy ? 'true' : 'false'},sessionSchema:'v4'}) + '\\n');
  process.exit(0);
}
process.exit(2);
`;
  fs.writeFileSync(executablePath, source, { mode: 0o755 });
  fs.chmodSync(executablePath, 0o755);
  return { executablePath, executableDigest: digest(Buffer.from(source)) };
}

function prepareAdoptionFixture(
  fixture: ReturnType<typeof fixtureRepository>,
  healthy: boolean,
) {
  createWip(fixture);
  const captured = capture(fixture);
  const envelope = maintenanceEnvelope(
    captured.intervention.parent.engineBinding,
  );
  const childReceipt = materializeInterventionChildWorktree(
    fixture.stateRoot,
    {
      parentChangeId: 'parent-A',
      repositoryRoot: fixture.repository,
      maintenanceGrantEnvelope: envelope,
    },
    humanDependencies(),
  );
  assert.equal(childReceipt.effectsPerformed, true);
  assert.equal(fs.existsSync(fixture.child), true);
  assert.equal(
    git(fixture.child, ['symbolic-ref', 'HEAD']).trim(),
    'refs/heads/work/intervention-B',
  );
  const executable = writeEngineExecutable(fixture.child, healthy);
  const artifact = createEngineArtifact({
    sourceChangeId: 'intervention-B',
    sourceDigest: digest('source-E2'),
    executableDigest: executable.executableDigest,
    protocolVersion: 3,
    canReadSessionSchemas: ['v4'],
    writesSessionSchema: 'v4',
    policySchemaVersion: 2,
    smokeReportDigest: digest(`smoke:${healthy}`),
  });
  persistInterventionEngineArtifact(fixture.stateRoot, {
    parentChangeId: 'parent-A',
    artifact,
    executablePath: executable.executablePath,
    now: NOW,
  });
  const adoption = preparePersistedEngineAdoption(
    fixture.stateRoot,
    {
      txId: `bootstrap-adoption-${healthy ? 'healthy' : 'unhealthy'}`,
      parentChangeId: 'parent-A',
      artifact,
      maintenanceGrantEnvelope: envelope,
      priorLocalAdoptions: 0,
    },
    humanDependencies(),
  );
  initializeLocalEngineBinding(fixture.stateRoot, fixture.bindingPath, {
    parentChangeId: 'parent-A',
    parentWorkspacePath: fixture.repository,
    parentBranch: 'refs/heads/work/parent-A',
    interventionChangeId: 'intervention-B',
    txId: adoption.journal.txId,
    checkpointId: captured.intervention.checkpoint.checkpointId,
    engineDigest: captured.intervention.parent.engineBinding,
    artifactId: artifact.artifactId,
    executableDigest: artifact.executableDigest,
    executablePath: localEngineArtifactPath(
      fixture.stateRoot,
      artifact.artifactId,
    ),
    sessionSchema: 'v4',
    now: NOW,
  });
  return {
    captured,
    envelope,
    artifact,
    adoption,
    ...executable,
  };
}

test('bootstrap creates a disjoint child worktree and commits a healthy local adoption', () => {
  const fixture = fixtureRepository();
  try {
    const prepared = prepareAdoptionFixture(fixture, true);
    let journalDigest = prepared.adoption.journal.journalDigest;
    const states: string[] = [];
    for (const at of [
      '2026-08-03T10:01:00.000Z',
      '2026-08-03T10:02:00.000Z',
      '2026-08-03T10:03:00.000Z',
      '2026-08-03T10:04:00.000Z',
      '2026-08-03T10:05:00.000Z',
    ]) {
      const step = executePersistedAdoptionStep(
        fixture.stateRoot,
        {
          txId: prepared.adoption.journal.txId,
          expectedJournalDigest: journalDigest,
          bindingPath: fixture.bindingPath,
          artifact: prepared.artifact,
          executablePath: prepared.executablePath,
          at,
        },
        humanDependencies(),
      );
      journalDigest = step.record.journal.journalDigest;
      states.push(step.record.journal.state);
    }
    assert.deepEqual(states, [
      'PARENT_CHECKPOINTED',
      'ENGINE_BINDING_UPDATED',
      'NEW_ENGINE_STARTED',
      'HEALTHY',
      'COMMITTED',
    ]);
    const terminalRetry = (at: string) =>
      executePersistedAdoptionStep(
        fixture.stateRoot,
        {
          txId: prepared.adoption.journal.txId,
          expectedJournalDigest: journalDigest,
          bindingPath: fixture.bindingPath,
          artifact: prepared.artifact,
          executablePath: prepared.executablePath,
          at,
        },
        humanDependencies(new Date(at)),
      );
    const firstNoop = terminalRetry('2026-08-03T12:00:00.000Z');
    const secondNoop = terminalRetry('2026-08-03T13:00:00.000Z');
    assert.equal(firstNoop.record.journal.state, 'COMMITTED');
    assert.equal(firstNoop.receipt.action, 'none');
    assert.equal(firstNoop.receipt.effectsPerformed, false);
    assert.deepEqual(secondNoop.receipt, firstNoop.receipt);
    const binding = readLocalEngineBinding(fixture.bindingPath);
    assert.equal(binding.engineDigest, prepared.artifact.executableDigest);
    assert.equal(binding.parentChangeId, 'parent-A');
    assert.equal(binding.sessionSchema, 'v4');
    assert.equal(binding.blocker, null);
    assert.equal(binding.interventionState, 'adopted');
    assert.equal(binding.generation, 3);
  } finally {
    fixture.cleanup();
  }
});

test('unhealthy adopted engine rolls the local binding back to E1 even after grant expiry', () => {
  const fixture = fixtureRepository();
  try {
    const prepared = prepareAdoptionFixture(fixture, false);
    let journalDigest = prepared.adoption.journal.journalDigest;
    let lastState = prepared.adoption.journal.state;
    for (const at of [
      '2026-08-03T10:01:00.000Z',
      '2026-08-03T10:02:00.000Z',
      '2026-08-03T10:03:00.000Z',
      '2026-08-03T10:04:00.000Z',
      '2026-08-03T10:05:00.000Z',
    ]) {
      const step = executePersistedAdoptionStep(
        fixture.stateRoot,
        {
          txId: prepared.adoption.journal.txId,
          expectedJournalDigest: journalDigest,
          bindingPath: fixture.bindingPath,
          artifact: prepared.artifact,
          executablePath: prepared.executablePath,
          at,
        },
        at === '2026-08-03T10:05:00.000Z'
          ? humanDependencies(new Date('2026-08-03T12:00:00.000Z'))
          : humanDependencies(),
      );
      journalDigest = step.record.journal.journalDigest;
      lastState = step.record.journal.state;
    }
    assert.equal(lastState, 'ENGINE_BINDING_ROLLED_BACK');
    const binding = readLocalEngineBinding(fixture.bindingPath);
    assert.equal(
      binding.engineDigest,
      prepared.captured.intervention.parent.engineBinding,
    );
    assert.deepEqual(binding.blocker, {
      kind: 'harness-intervention',
      checkpointId: prepared.captured.intervention.checkpoint.checkpointId,
      blockedBy: 'intervention-B',
    });
    assert.equal(binding.interventionState, 'active');
    assert.equal(binding.generation, 3);
  } finally {
    fixture.cleanup();
  }
});
