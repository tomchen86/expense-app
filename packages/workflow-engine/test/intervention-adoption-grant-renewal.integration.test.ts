import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  dispatchBootstrapInterventionCommand,
  type BootstrapInterventionCliDependencies,
} from '../src/intervention-control-bootstrap-cli.ts';
import { createEngineArtifact } from '../src/intervention-control.ts';
import { recoverPersistedEngineAdoption } from '../src/intervention-control-persistence.ts';
import {
  persistInterventionEngineArtifact,
  readMaintenanceGrantForParent,
} from '../src/intervention-maintenance.ts';

const NOW = new Date('2026-08-03T10:00:00.000Z');
const AFTER_EXPIRY = new Date('2026-08-03T10:31:00.000Z');

function digest(value: string | Buffer): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function git(repositoryRoot: string, args: string[]): string {
  return execFileSync('git', ['-C', repositoryRoot, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function fixtureRepository() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'intervention-grant-renewal-')),
  );
  fs.chmodSync(root, 0o700);
  const repositoryRoot = path.join(root, 'parent');
  fs.mkdirSync(repositoryRoot, { mode: 0o700 });
  git(repositoryRoot, ['init', '-b', 'work/parent-A']);
  git(repositoryRoot, ['config', 'user.email', 'workflow@example.test']);
  git(repositoryRoot, ['config', 'user.name', 'Workflow Test']);
  const origin = 'https://github.com/example/intervention-renewal.git';
  git(repositoryRoot, ['remote', 'add', 'origin', origin]);
  fs.mkdirSync(path.join(repositoryRoot, 'workflow'), { mode: 0o700 });
  fs.writeFileSync(
    path.join(repositoryRoot, 'workflow/maintainer-policy.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        repository: { id: 'github:R_intervention_renewal', origin },
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
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(path.join(repositoryRoot, 'tracked.txt'), 'base\n');
  git(repositoryRoot, ['add', '.']);
  git(repositoryRoot, ['commit', '-m', 'Create fixture baseline']);
  const gitCommonValue = git(repositoryRoot, [
    'rev-parse',
    '--git-common-dir',
  ]).trim();
  const gitCommonDirectory = fs.realpathSync(
    path.isAbsolute(gitCommonValue)
      ? gitCommonValue
      : path.resolve(repositoryRoot, gitCommonValue),
  );
  const stateRoot = path.join(
    gitCommonDirectory,
    'workflow-engine',
    'intervention-control',
  );
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const sessionSnapshotPath = path.join(
    stateRoot,
    'parent-session-snapshot.json',
  );
  fs.writeFileSync(sessionSnapshotPath, '{"checkpoint":"plan-review"}\n', {
    mode: 0o600,
  });
  return {
    root,
    repositoryRoot,
    stateRoot,
    sessionSnapshotPath,
    externalAuditRoot: path.join(root, 'authority-audit'),
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

type Fixture = ReturnType<typeof fixtureRepository>;

function dependencies(
  fixture: Fixture,
  options: { now?: Date; afterAdoptionStep?: () => void } = {},
): BootstrapInterventionCliDependencies {
  const now = options.now ?? NOW;
  return {
    now: () => new Date(now.getTime()),
    resolveParentDurableState({ parentChangeId }) {
      return {
        parent: {
          changeId: parentChangeId,
          status: 'active',
          engineBinding: digest('engine-E1'),
          sessionSchema: 'v4',
          blocker: null,
        },
        sessionSnapshotPath: fixture.sessionSnapshotPath,
        pendingIntent: 'Resume parent-A under the repaired engine.',
        policyDigest: digest('policy-E1'),
      };
    },
    maintenanceSigner: {
      assertHumanPresent() {},
      identity() {
        return 'maintainer@example.test';
      },
      sign() {
        return 'renewal-human-signature';
      },
      verify() {},
    },
    verifyHumanSignature(_payload, signature, signer, namespace) {
      assert.equal(signature, 'renewal-human-signature');
      assert.equal(signer, 'maintainer@example.test');
      assert.equal(namespace, 'expense-app.harness-maintenance-grant.v1');
      return true;
    },
    presentMaintenanceSummary() {},
    testHooks: { afterAdoptionStep: options.afterAdoptionStep },
  };
}

function intervene(
  fixture: Fixture,
  commandDependencies: BootstrapInterventionCliDependencies,
) {
  return dispatchBootstrapInterventionCommand(
    [
      'change',
      'intervene',
      'parent-A',
      '--reason',
      'Repair the blocked workflow engine.',
      '--audit-root',
      fixture.externalAuditRoot,
    ],
    fixture.repositoryRoot,
    commandDependencies,
  );
}

function persistHealthyArtifact(fixture: Fixture, childWorkspacePath: string) {
  const executablePath = path.join(childWorkspacePath, 'engine-renewal.mjs');
  const source = `#!/usr/bin/env node
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
  fs.writeFileSync(executablePath, source, { mode: 0o755 });
  const artifact = createEngineArtifact({
    sourceChangeId: path
      .basename(childWorkspacePath)
      .slice(`${path.basename(fixture.repositoryRoot)}-`.length),
    sourceDigest: digest('renewal-source'),
    executableDigest: digest(Buffer.from(source)),
    protocolVersion: 3,
    canReadSessionSchemas: ['v4'],
    writesSessionSchema: 'v4',
    policySchemaVersion: 2,
    smokeReportDigest: digest('renewal-smoke'),
  });
  persistInterventionEngineArtifact(fixture.stateRoot, {
    parentChangeId: 'parent-A',
    artifact,
    executablePath,
    now: NOW,
  });
  return artifact;
}

function adopt(
  fixture: Fixture,
  artifactId: `sha256:${string}`,
  commandDependencies: BootstrapInterventionCliDependencies,
) {
  return dispatchBootstrapInterventionCommand(
    [
      'engine',
      'adopt',
      artifactId,
      '--into',
      'parent-A',
      '--audit-root',
      fixture.externalAuditRoot,
    ],
    fixture.repositoryRoot,
    commandDependencies,
  );
}

function adoptionTransactionId(artifactId: `sha256:${string}`): string {
  return `adoption-${crypto
    .createHash('sha256')
    .update(`local-engine-adoption\0parent-A\0${artifactId}`)
    .digest('hex')}`;
}

test('an exact renewed grant resumes a crash before the engine binding switch', () => {
  const fixture = fixtureRepository();
  try {
    fs.writeFileSync(path.join(fixture.repositoryRoot, 'tracked.txt'), 'wip\n');
    const intervention = intervene(
      fixture,
      dependencies(fixture),
    ).intervention!;
    const artifact = persistHealthyArtifact(
      fixture,
      intervention.childWorkspace.childWorkspacePath,
    );
    const originalGrant = readMaintenanceGrantForParent(
      fixture.stateRoot,
      'parent-A',
    );
    let steps = 0;
    assert.throws(
      () =>
        adopt(
          fixture,
          artifact.artifactId,
          dependencies(fixture, {
            afterAdoptionStep() {
              steps += 1;
              throw new Error('simulated pre-switch crash');
            },
          }),
        ),
      /simulated pre-switch crash/,
    );
    const txId = adoptionTransactionId(artifact.artifactId);
    assert.equal(
      recoverPersistedEngineAdoption(fixture.stateRoot, txId).record.journal
        .state,
      'PARENT_CHECKPOINTED',
    );

    const renewedDependencies = dependencies(fixture, { now: AFTER_EXPIRY });
    intervene(fixture, renewedDependencies);
    const renewedGrant = readMaintenanceGrantForParent(
      fixture.stateRoot,
      'parent-A',
    );
    assert.notEqual(
      renewedGrant.envelope.payload.grantId,
      originalGrant.envelope.payload.grantId,
    );

    const resumed = adopt(fixture, artifact.artifactId, renewedDependencies);
    assert.equal(resumed.adoptionState, 'COMMITTED');
    assert.equal(
      resumed.adoption?.journal.grantId,
      renewedGrant.envelope.payload.grantId,
    );
    assert.equal(
      resumed.adoption?.observations.some(
        ({ eventKind }) => eventKind === 'maintenance-grant-renewed',
      ),
      true,
    );
  } finally {
    fixture.cleanup();
  }
});

test('expiry after the engine binding switch cannot prevent obligatory recovery', () => {
  const fixture = fixtureRepository();
  try {
    fs.writeFileSync(path.join(fixture.repositoryRoot, 'tracked.txt'), 'wip\n');
    const intervention = intervene(
      fixture,
      dependencies(fixture),
    ).intervention!;
    const artifact = persistHealthyArtifact(
      fixture,
      intervention.childWorkspace.childWorkspacePath,
    );
    const originalGrant = readMaintenanceGrantForParent(
      fixture.stateRoot,
      'parent-A',
    );
    let steps = 0;
    assert.throws(
      () =>
        adopt(
          fixture,
          artifact.artifactId,
          dependencies(fixture, {
            afterAdoptionStep() {
              steps += 1;
              if (steps === 2) throw new Error('simulated post-switch crash');
            },
          }),
        ),
      /simulated post-switch crash/,
    );
    const txId = adoptionTransactionId(artifact.artifactId);
    assert.equal(
      recoverPersistedEngineAdoption(fixture.stateRoot, txId).record.journal
        .state,
      'ENGINE_BINDING_UPDATED',
    );

    const resumed = adopt(
      fixture,
      artifact.artifactId,
      dependencies(fixture, { now: AFTER_EXPIRY }),
    );
    assert.equal(resumed.adoptionState, 'COMMITTED');
    assert.equal(
      resumed.adoption?.journal.grantId,
      originalGrant.envelope.payload.grantId,
    );
  } finally {
    fixture.cleanup();
  }
});
