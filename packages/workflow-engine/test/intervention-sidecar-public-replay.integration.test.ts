import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  dispatchBootstrapInterventionCommand,
  type BootstrapInterventionCliDependencies,
} from '../src/intervention-control-bootstrap-cli.ts';
import { createEngineArtifact } from '../src/modules/authority/intervention-control.ts';
import {
  readPersistedBootstrapSidecarWorkflow,
  readPersistedEngineAdoption,
} from '../src/intervention-control-persistence.ts';
import { persistInterventionEngineArtifact } from '../src/application/control-plane/intervention-maintenance.ts';

const NOW = new Date('2026-08-03T10:00:00.000Z');

function digest(value: string | Buffer): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function git(repository: string, args: string[]): string {
  return childProcess.execFileSync('git', ['-C', repository, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function fixture() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-public-replay-')),
  );
  fs.chmodSync(root, 0o700);
  const repository = path.join(root, 'parent');
  fs.mkdirSync(repository, { mode: 0o700 });
  git(repository, ['init', '-b', 'work/parent-A']);
  git(repository, ['config', 'user.email', 'workflow@example.test']);
  git(repository, ['config', 'user.name', 'Workflow Test']);
  const origin = 'https://github.com/example/intervention-fixture.git';
  git(repository, ['remote', 'add', 'origin', origin]);
  fs.mkdirSync(path.join(repository, 'workflow'), { mode: 0o700 });
  fs.writeFileSync(
    path.join(repository, 'workflow', 'maintainer-policy.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      repository: { id: 'github:R_intervention_fixture', origin },
      phase: 'bootstrap',
      auditTagPrefix: 'refs/tags/workflow-grant/',
      signatureNamespace: 'expense-app.workflow.maintainer-grant.v1',
      maxTtlMinutes: 30,
      maxUses: 1,
      bootstrapEligiblePaths: ['packages/workflow-engine/**'],
      sealedImmutablePaths: [],
      requiredChecks: ['fixture'],
      trustedSigners: [
        {
          identity: 'maintainer@example.test',
          publicKey:
            'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJL6dVljsgm9EAbjCiOhA/tKsgApOhKmcB/NRewL1uns',
          fingerprint: 'SHA256:7UB1aHADtIMUJBFt3sjo9RwoBDgCKc1B1GlEucUDL4U',
        },
      ],
    })}\n`,
  );
  fs.writeFileSync(path.join(repository, 'tracked.txt'), 'base\n');
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'Create public replay fixture']);
  const gitCommon = fs.realpathSync(path.join(repository, '.git'));
  const stateRoot = path.join(
    gitCommon,
    'workflow-engine',
    'intervention-control',
  );
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const snapshot = path.join(stateRoot, 'parent-session-snapshot.json');
  fs.writeFileSync(snapshot, '{"checkpoint":"repair"}\n', { mode: 0o600 });
  fs.writeFileSync(path.join(repository, 'tracked.txt'), 'repair wip\n');
  return {
    root,
    repository,
    stateRoot,
    snapshot,
    auditRoot: path.join(root, 'authority-audit'),
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function dependencies(
  value: ReturnType<typeof fixture>,
  crashAfterCommit = false,
): BootstrapInterventionCliDependencies {
  const testHooks = crashAfterCommit
    ? {
        afterAdoptionReceiptPersistedBeforeSidecar() {
          throw new Error('crash-after-committed-receipt');
        },
      }
    : undefined;
  return {
    now: () => new Date(NOW),
    resolveParentDurableState() {
      return {
        parent: {
          changeId: 'parent-A',
          status: 'active',
          engineBinding: digest('public-replay-E1'),
          sessionSchema: 'v4',
          blocker: null,
        },
        sessionSnapshotPath: value.snapshot,
        pendingIntent:
          'Resume only after public replay reconciles the sidecar.',
        policyDigest: digest('public-replay-policy'),
      };
    },
    maintenanceSigner: {
      assertHumanPresent() {},
      identity() {
        return 'maintainer@example.test';
      },
      sign() {
        return 'public-replay-signature';
      },
      verify() {},
    },
    verifyHumanSignature(_payload, signature, signer, namespace) {
      return (
        signature === 'public-replay-signature' &&
        signer === 'maintainer@example.test' &&
        namespace === 'expense-app.harness-maintenance-grant.v1'
      );
    },
    presentMaintenanceSummary() {},
    testHooks: testHooks as BootstrapInterventionCliDependencies['testHooks'],
  };
}

function engineSource(): string {
  return `#!/usr/bin/env node
const mode = process.argv[2];
if (mode === '--bootstrap-probe') {
  process.stdout.write(JSON.stringify({kind:'engine-bootstrap-probe.v1',started:true,sessionSchema:'v4'}) + '\\n');
  process.exit(0);
}
if (mode === '--health-check') {
  process.stdout.write(JSON.stringify({kind:'engine-health.v1',healthy:true,sessionSchema:'v4'}) + '\\n');
  process.exit(0);
}
process.exit(2);
`;
}

test('public engine-adopt no-op replay reconciles a COMMITTED sidecar crash', () => {
  const value = fixture();
  try {
    const intervention = dispatchBootstrapInterventionCommand(
      [
        'change',
        'intervene',
        'parent-A',
        '--reason',
        'Repair the public replay engine.',
        '--audit-root',
        value.auditRoot,
      ],
      value.repository,
      dependencies(value),
    ).intervention!;
    const executablePath = path.join(
      intervention.childWorkspace.childWorkspacePath,
      'engine-probe.mjs',
    );
    const source = engineSource();
    fs.writeFileSync(executablePath, source, { mode: 0o755 });
    fs.chmodSync(executablePath, 0o755);
    const artifact = createEngineArtifact({
      sourceChangeId: intervention.relationship.interventionChangeId,
      sourceDigest: digest('public-replay-source'),
      executableDigest: digest(source),
      protocolVersion: 3,
      canReadSessionSchemas: ['v4'],
      writesSessionSchema: 'v4',
      policySchemaVersion: 2,
      smokeReportDigest: digest('public-replay-smoke'),
    });
    persistInterventionEngineArtifact(value.stateRoot, {
      parentChangeId: 'parent-A',
      artifact,
      executablePath,
      now: NOW,
    });
    const argv = [
      'engine',
      'adopt',
      artifact.artifactId,
      '--into',
      'parent-A',
      '--audit-root',
      value.auditRoot,
    ];
    assert.throws(
      () =>
        dispatchBootstrapInterventionCommand(
          argv,
          value.repository,
          dependencies(value, true),
        ),
      /crash-after-committed-receipt/,
    );
    const sidecarBefore = readPersistedBootstrapSidecarWorkflow(
      value.stateRoot,
      'parent-A',
    );
    assert.equal(sidecarBefore.state, 'repair-active');
    const adoptionFile = fs.readdirSync(
      path.join(value.stateRoot, 'adoptions'),
    )[0]!;
    const rawAdoption = JSON.parse(
      fs.readFileSync(
        path.join(value.stateRoot, 'adoptions', adoptionFile),
        'utf8',
      ),
    );
    assert.equal(
      readPersistedEngineAdoption(value.stateRoot, rawAdoption.journal.txId)
        .journal.state,
      'COMMITTED',
    );
    const replay = dispatchBootstrapInterventionCommand(
      argv,
      value.repository,
      dependencies(value),
    );
    assert.equal(replay.adoptionState, 'COMMITTED');
    assert.equal(replay.effectsPerformed, false);
    const sidecarAfter = readPersistedBootstrapSidecarWorkflow(
      value.stateRoot,
      'parent-A',
    );
    assert.equal(sidecarAfter.state, 'adopted');
    assert.equal(sidecarAfter.parentUnblock.state, 'unblocked');
  } finally {
    value.cleanup();
  }
});
