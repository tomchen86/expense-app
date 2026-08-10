import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  bootstrapInterventionUsage,
  dispatchBootstrapInterventionCommand,
  type BootstrapInterventionCliDependencies,
} from '../src/intervention-control-bootstrap-cli.ts';
import {
  canonicalHarnessMaintenanceGrantPayload,
  createEngineArtifact,
} from '../src/intervention-control.ts';
import {
  persistInterventionEngineArtifact,
  readInterventionEngineArtifact,
  readMaintenanceGrantRecord,
  readMaintenanceGrantForParent,
} from '../src/intervention-maintenance.ts';
import { readPersistedIntervention } from '../src/intervention-control-persistence.ts';
import {
  deriveAuthorityAuditRepositoryId,
  scanAuthorityAuditLedger,
} from '../src/authority-audit-ledger.ts';
import { verifyAuthorityAuditEvents } from '../src/authority-audit-service.ts';
import { ExitCode, WorkflowError, workflowError } from '../src/errors.ts';

const NOW = new Date('2026-08-03T10:00:00.000Z');

function digest(value: string | Buffer): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function hasCode(code: string) {
  return (error: unknown): boolean =>
    error instanceof WorkflowError && error.code === code;
}

function git(repositoryRoot: string, args: string[]): string {
  return execFileSync('git', ['-C', repositoryRoot, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function fixtureRepository() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'intervention-human-cli-')),
  );
  fs.chmodSync(root, 0o700);
  const repositoryRoot = path.join(root, 'parent');
  fs.mkdirSync(repositoryRoot, { mode: 0o700 });
  git(repositoryRoot, ['init', '-b', 'work/parent-A']);
  git(repositoryRoot, ['config', 'user.email', 'workflow@example.test']);
  git(repositoryRoot, ['config', 'user.name', 'Workflow Test']);
  const origin = 'https://github.com/example/intervention-fixture.git';
  git(repositoryRoot, ['remote', 'add', 'origin', origin]);
  fs.mkdirSync(path.join(repositoryRoot, 'workflow'), { mode: 0o700 });
  fs.writeFileSync(
    path.join(repositoryRoot, 'workflow/maintainer-policy.json'),
    `${JSON.stringify(
      {
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
  const externalAuditRoot = path.join(root, 'authority-audit');
  const auditScope = {
    externalAuditRoot,
    repositoryRoot,
    repositoryId: deriveAuthorityAuditRepositoryId(
      `git-common:${gitCommonDirectory}`,
    ),
  };
  return {
    root,
    repositoryRoot,
    gitCommonDirectory,
    stateRoot,
    sessionSnapshotPath,
    externalAuditRoot,
    auditScope,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

type Fixture = ReturnType<typeof fixtureRepository>;

function createParentWip(fixture: Fixture): void {
  fs.writeFileSync(path.join(fixture.repositoryRoot, 'tracked.txt'), 'wip\n');
  fs.writeFileSync(
    path.join(fixture.repositoryRoot, 'note.bin'),
    Buffer.from([0, 1, 2, 255]),
  );
}

function humanDependencies(
  fixture: Fixture,
  options: {
    now?: Date;
    tty?: boolean;
    signatureValid?: boolean;
    afterMaintenanceGrantPersisted?: () => void;
    afterAdoptionStep?: () => void;
    afterBindingUpdatedBeforeJournal?: () => void;
    afterAbandonmentIntentPersisted?: () => void;
  } = {},
) {
  const observed = {
    humanPresenceChecks: 0,
    identityCalls: 0,
    resolverCalls: 0,
    signatures: [] as Array<{ payload: string; namespace?: string }>,
    summaries: [] as Array<{
      checkpointId: string;
      reason: string;
      maxLocalAdoptions: number;
      humanReadable: string;
      scope: { paths: string[]; operations: string[] };
      waivers: string[];
    }>,
  };
  const now = options.now ?? NOW;
  const dependencies: BootstrapInterventionCliDependencies = {
    now: () => new Date(now.getTime()),
    resolveParentDurableState({ parentChangeId }) {
      observed.resolverCalls += 1;
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
      assertHumanPresent() {
        observed.humanPresenceChecks += 1;
        if (options.tty === false) {
          throw workflowError(
            'MAINTAINER_INTERACTIVE_REQUIRED',
            'A controlling terminal is required.',
            ExitCode.unsafeEnvironment,
          );
        }
      },
      identity() {
        observed.identityCalls += 1;
        return 'maintainer@example.test';
      },
      sign(payload, namespace) {
        observed.signatures.push({ payload, namespace });
        return 'bootstrap-cli-human-signature';
      },
      verify() {},
    },
    verifyHumanSignature(_payload, signature, signer, namespace) {
      assert.equal(signature, 'bootstrap-cli-human-signature');
      assert.equal(signer, 'maintainer@example.test');
      assert.equal(namespace, 'expense-app.harness-maintenance-grant.v1');
      return options.signatureValid !== false;
    },
    presentMaintenanceSummary(summary) {
      observed.summaries.push(structuredClone(summary));
    },
    testHooks: {
      afterMaintenanceGrantPersisted: options.afterMaintenanceGrantPersisted,
      afterAdoptionStep: options.afterAdoptionStep,
      afterBindingUpdatedBeforeJournal:
        options.afterBindingUpdatedBeforeJournal,
      afterAbandonmentIntentPersisted: options.afterAbandonmentIntentPersisted,
    },
  };
  return { dependencies, observed };
}

function intervene(
  fixture: Fixture,
  dependencies: BootstrapInterventionCliDependencies,
  reason = 'Repair the blocked workflow engine.',
) {
  return dispatchBootstrapInterventionCommand(
    [
      'change',
      'intervene',
      'parent-A',
      '--reason',
      reason,
      '--audit-root',
      fixture.externalAuditRoot,
    ],
    fixture.repositoryRoot,
    dependencies,
  );
}

function writeEngineExecutable(
  childWorkspacePath: string,
  healthy: boolean,
  label = 'engine-probe',
) {
  const executablePath = path.join(childWorkspacePath, `${label}.mjs`);
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

function persistArtifact(
  fixture: Fixture,
  childWorkspacePath: string,
  healthy: boolean,
  label = 'engine-probe',
) {
  const executable = writeEngineExecutable(childWorkspacePath, healthy, label);
  const artifact = createEngineArtifact({
    sourceChangeId: path
      .basename(childWorkspacePath)
      .slice(`${path.basename(fixture.repositoryRoot)}-`.length),
    sourceDigest: digest(`source:${label}`),
    executableDigest: executable.executableDigest,
    protocolVersion: 3,
    canReadSessionSchemas: ['v4'],
    writesSessionSchema: 'v4',
    policySchemaVersion: 2,
    smokeReportDigest: digest(`smoke:${label}`),
  });
  persistInterventionEngineArtifact(fixture.stateRoot, {
    parentChangeId: 'parent-A',
    artifact,
    executablePath: executable.executablePath,
    now: NOW,
  });
  return { artifact, ...executable };
}

test('human intervene derives durable state, presents exact scope, signs once, and replays without mutation', () => {
  const fixture = fixtureRepository();
  try {
    createParentWip(fixture);
    const human = humanDependencies(fixture);
    const first = intervene(fixture, human.dependencies);
    assert.equal(first.action, 'intervene');
    assert.equal(first.effectsPerformed, true);
    assert.equal(human.observed.resolverCalls, 1);
    assert.equal(human.observed.humanPresenceChecks, 1);
    assert.equal(human.observed.signatures.length, 1);
    assert.equal(human.observed.summaries.length, 1);
    const summary = human.observed.summaries[0]!;
    // What the maintainer is shown before signing. The scope names only a
    // package this repository has, and the waivers are every one the grant type
    // admits — a partial list would let a rule the design says is waivable stop
    // the intervention with nothing in the record saying why.
    assert.deepEqual(summary.scope.paths, ['packages/workflow-engine/**']);
    assert.deepEqual(summary.waivers, [
      'active-change-exclusivity',
      'clean-worktree-required',
      'engine-path-protection',
      'parent-terminalization-required',
      'selected-workflow-check',
    ]);
    assert.equal(summary.maxLocalAdoptions, 1);
    assert.match(
      summary.humanReadable,
      /Repository-default\/global engine promotion: forbidden/,
    );
    assert.match(summary.humanReadable, /Exact scope paths:/);
    assert.equal(
      summary.humanReadable.includes(fixture.externalAuditRoot),
      true,
    );

    const intervention = first.intervention!;
    assert.equal(
      summary.humanReadable.includes(
        intervention.childWorkspace.childWorkspacePath,
      ),
      true,
    );
    assert.equal(
      summary.humanReadable.includes(intervention.childWorkspace.changeRef),
      true,
    );
    assert.equal(
      fs.existsSync(intervention.childWorkspace.childWorkspacePath),
      true,
    );
    assert.equal(
      git(intervention.childWorkspace.childWorkspacePath, [
        'symbolic-ref',
        'HEAD',
      ]).trim(),
      intervention.childWorkspace.changeRef,
    );
    const grant = readMaintenanceGrantForParent(fixture.stateRoot, 'parent-A');
    assert.deepEqual(grant.authorityAudit, {
      externalAuditRoot: fixture.externalAuditRoot,
      repositoryId: fixture.auditScope.repositoryId,
    });
    assert.equal(
      human.observed.signatures[0]!.payload,
      canonicalHarnessMaintenanceGrantPayload(grant.envelope.payload),
    );
    assert.equal(
      human.observed.signatures[0]!.namespace,
      'expense-app.harness-maintenance-grant.v1',
    );
    assert.equal(
      Date.parse(grant.envelope.payload.expiresAt) -
        Date.parse(grant.envelope.payload.issuedAt),
      30 * 60 * 1000,
    );

    const replay = intervene(fixture, human.dependencies);
    assert.equal(replay.effectsPerformed, false);
    assert.equal(human.observed.resolverCalls, 1);
    assert.equal(human.observed.humanPresenceChecks, 1);
    assert.equal(human.observed.signatures.length, 1);
    assert.equal(scanAuthorityAuditLedger(fixture.auditScope).recordCount, 2);
  } finally {
    fixture.cleanup();
  }
});

test('controlling-TTY and signature failures have stable codes and never materialize a child', () => {
  const noTtyFixture = fixtureRepository();
  try {
    createParentWip(noTtyFixture);
    const noTty = humanDependencies(noTtyFixture, { tty: false });
    assert.throws(
      () => intervene(noTtyFixture, noTty.dependencies),
      hasCode('MAINTAINER_INTERACTIVE_REQUIRED'),
    );
    assert.equal(noTty.observed.resolverCalls, 1);
    assert.equal(noTty.observed.summaries.length, 1);
    assert.equal(noTty.observed.identityCalls, 0);
    assert.equal(noTty.observed.signatures.length, 0);
    assert.throws(
      () => readMaintenanceGrantForParent(noTtyFixture.stateRoot, 'parent-A'),
      hasCode('MAINTENANCE_GRANT_RECORD_NOT_FOUND'),
    );
    assert.equal(
      fs.existsSync(
        noTty.observed.summaries[0]!.humanReadable.match(
          /Reserved child workspace: (.+)/,
        )![1]!,
      ),
      false,
    );
    const overlappingAudit = humanDependencies(noTtyFixture);
    assert.throws(
      () =>
        dispatchBootstrapInterventionCommand(
          [
            'change',
            'intervene',
            'parent-A',
            '--reason',
            'Repair the blocked workflow engine.',
            '--audit-root',
            path.join(noTtyFixture.repositoryRoot, 'audit'),
          ],
          noTtyFixture.repositoryRoot,
          overlappingAudit.dependencies,
        ),
      hasCode('AUTHORITY_AUDIT_EXTERNAL_ROOT_REQUIRED'),
    );
    assert.equal(overlappingAudit.observed.resolverCalls, 0);
    assert.equal(
      fs.existsSync(path.join(noTtyFixture.repositoryRoot, 'audit')),
      false,
    );
  } finally {
    noTtyFixture.cleanup();
  }

  const invalidFixture = fixtureRepository();
  try {
    createParentWip(invalidFixture);
    const invalid = humanDependencies(invalidFixture, {
      signatureValid: false,
    });
    assert.throws(
      () => intervene(invalidFixture, invalid.dependencies),
      hasCode('MAINTENANCE_GRANT_SIGNATURE_INVALID'),
    );
    assert.equal(invalid.observed.signatures.length, 1);
    assert.equal(invalid.observed.summaries.length, 1);
    assert.throws(
      () => readMaintenanceGrantForParent(invalidFixture.stateRoot, 'parent-A'),
      hasCode('MAINTENANCE_GRANT_RECORD_NOT_FOUND'),
    );
    const directories = fs
      .readdirSync(invalidFixture.root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    assert.deepEqual(directories, ['authority-audit', 'parent']);
  } finally {
    invalidFixture.cleanup();
  }
});

test('invalid durable parent preflight fails before touching the human signer', () => {
  const fixture = fixtureRepository();
  try {
    createParentWip(fixture);
    const invalid = humanDependencies(fixture);
    invalid.dependencies.resolveParentDurableState = () => {
      throw workflowError(
        'HARNESS_BOOTSTRAP_PARENT_SESSION_STALE',
        'Durable parent session is stale.',
        ExitCode.staleState,
      );
    };
    assert.throws(
      () => intervene(fixture, invalid.dependencies),
      hasCode('HARNESS_BOOTSTRAP_PARENT_SESSION_STALE'),
    );
    assert.equal(invalid.observed.humanPresenceChecks, 0);
    assert.equal(invalid.observed.identityCalls, 0);
    assert.equal(invalid.observed.signatures.length, 0);
    assert.equal(invalid.observed.summaries.length, 0);
  } finally {
    fixture.cleanup();
  }
});

test('expired maintenance authority can be renewed and revocation abandons before a fresh intervention', () => {
  for (const mode of ['expired', 'revoked'] as const) {
    const fixture = fixtureRepository();
    try {
      createParentWip(fixture);
      const crash = humanDependencies(fixture, {
        afterMaintenanceGrantPersisted() {
          throw new Error('simulated grant-persistence crash');
        },
      });
      assert.throws(
        () => intervene(fixture, crash.dependencies),
        /simulated grant-persistence crash/,
      );
      const intervention = crash.observed.summaries[0]!;
      const persisted = readMaintenanceGrantForParent(
        fixture.stateRoot,
        'parent-A',
      );
      assert.equal(persisted.state, 'available');
      if (mode === 'revoked') {
        assert.throws(
          () =>
            dispatchBootstrapInterventionCommand(
              [
                'change',
                'revoke-intervention',
                'parent-A',
                '--reason',
                'Maintainer cancelled the repair.',
              ],
              fixture.repositoryRoot,
              humanDependencies(fixture, { tty: false }).dependencies,
            ),
          hasCode('MAINTAINER_INTERACTIVE_REQUIRED'),
        );
        assert.equal(
          readMaintenanceGrantForParent(fixture.stateRoot, 'parent-A').state,
          'available',
        );
        const revoked = dispatchBootstrapInterventionCommand(
          [
            'change',
            'revoke-intervention',
            'parent-A',
            '--reason',
            'Maintainer cancelled the repair.',
          ],
          fixture.repositoryRoot,
          humanDependencies(fixture).dependencies,
        );
        assert.equal(revoked.action, 'revoke-intervention');
        const revokeReplay = dispatchBootstrapInterventionCommand(
          [
            'change',
            'revoke-intervention',
            'parent-A',
            '--reason',
            'Maintainer cancelled the repair.',
          ],
          fixture.repositoryRoot,
          humanDependencies(fixture).dependencies,
        );
        assert.equal(revokeReplay.effectsPerformed, false);
        assert.throws(
          () =>
            dispatchBootstrapInterventionCommand(
              [
                'change',
                'revoke-intervention',
                'parent-A',
                '--reason',
                'A different reason must not replace the tombstone.',
              ],
              fixture.repositoryRoot,
              humanDependencies(fixture).dependencies,
            ),
          hasCode('HUMAN_REVOCATION_CONFLICT'),
        );
        const terminal = readMaintenanceGrantRecord(
          fixture.stateRoot,
          persisted.envelope.payload.grantId,
        );
        assert.equal(terminal.state, 'revoked');
        const restartedHuman = humanDependencies(fixture);
        const restarted = intervene(fixture, restartedHuman.dependencies);
        assert.equal(restarted.action, 'intervene');
        assert.equal(restarted.effectsPerformed, true);
        assert.notEqual(
          restarted.intervention?.relationship.interventionChangeId,
          persisted.interventionChangeId,
        );
        assert.equal(restartedHuman.observed.signatures.length, 1);
      } else {
        const renewal = humanDependencies(fixture, {
          now: new Date('2026-08-03T10:31:00.000Z'),
        });
        const renewed = intervene(fixture, renewal.dependencies);
        assert.equal(renewed.action, 'intervene');
        assert.equal(renewed.effectsPerformed, true);
        const terminal = readMaintenanceGrantRecord(
          fixture.stateRoot,
          persisted.envelope.payload.grantId,
        );
        assert.equal(terminal.state, 'expired');
        assert.equal(terminal.expiredAt, terminal.envelope.payload.expiresAt);
        const active = readMaintenanceGrantForParent(
          fixture.stateRoot,
          'parent-A',
        );
        assert.equal(active.state, 'available');
        assert.notEqual(
          active.envelope.payload.grantId,
          terminal.envelope.payload.grantId,
        );
        assert.equal(renewal.observed.signatures.length, 1);
        const replay = intervene(fixture, renewal.dependencies);
        assert.equal(replay.effectsPerformed, false);
        assert.equal(renewal.observed.signatures.length, 1);
      }
      const child = path.join(
        path.dirname(fixture.repositoryRoot),
        `${path.basename(fixture.repositoryRoot)}-${persisted.interventionChangeId}`,
      );
      assert.equal(intervention.checkpointId, persisted.checkpointId);
      assert.equal(fs.existsSync(child), mode === 'expired');
    } finally {
      fixture.cleanup();
    }
  }
});

test('engine adopt reads only persisted state, commits once, and rejects grant reuse', () => {
  const fixture = fixtureRepository();
  try {
    createParentWip(fixture);
    const human = humanDependencies(fixture);
    const intervention = intervene(fixture, human.dependencies).intervention!;
    const firstArtifact = persistArtifact(
      fixture,
      intervention.childWorkspace.childWorkspacePath,
      true,
      'engine-healthy-1',
    );
    const differentAuditRoot = path.join(fixture.root, 'different-audit');
    assert.throws(
      () =>
        dispatchBootstrapInterventionCommand(
          [
            'engine',
            'adopt',
            firstArtifact.artifact.artifactId,
            '--into',
            'parent-A',
            '--audit-root',
            differentAuditRoot,
          ],
          fixture.repositoryRoot,
          human.dependencies,
        ),
      hasCode('INTERVENTION_AUTHORITY_AUDIT_BINDING_MISMATCH'),
    );
    assert.equal(fs.existsSync(differentAuditRoot), false);
    let audit = scanAuthorityAuditLedger(fixture.auditScope);
    assert.equal(audit.recordCount, 3);
    assert.equal(audit.records.at(-1)?.record.eventType, 'error');
    assert.equal(
      verifyAuthorityAuditEvents(fixture.auditScope).events.at(-1)?.event
        .errorCode,
      'INTERVENTION_AUTHORITY_AUDIT_BINDING_MISMATCH',
    );
    assert.deepEqual(
      fs.readdirSync(path.join(fixture.stateRoot, 'adoptions')),
      [],
    );
    const first = dispatchBootstrapInterventionCommand(
      [
        'engine',
        'adopt',
        firstArtifact.artifact.artifactId,
        '--into',
        'parent-A',
        '--audit-root',
        fixture.externalAuditRoot,
      ],
      fixture.repositoryRoot,
      human.dependencies,
    );
    assert.equal(first.action, 'engine-adopt');
    assert.equal(first.adoptionState, 'COMMITTED');
    assert.equal(
      first.parentSession?.engineDigest,
      firstArtifact.executableDigest,
    );
    assert.equal(first.parentSession?.blocker, null);
    assert.equal(first.effectsPerformed, true);

    const replay = dispatchBootstrapInterventionCommand(
      [
        'engine',
        'adopt',
        firstArtifact.artifact.artifactId,
        '--into',
        'parent-A',
        '--audit-root',
        fixture.externalAuditRoot,
      ],
      fixture.repositoryRoot,
      human.dependencies,
    );
    assert.equal(replay.adoptionState, 'COMMITTED');
    assert.equal(replay.effectsPerformed, false);

    const secondArtifact = persistArtifact(
      fixture,
      intervention.childWorkspace.childWorkspacePath,
      true,
      'engine-healthy-2',
    );
    assert.throws(
      () =>
        dispatchBootstrapInterventionCommand(
          [
            'engine',
            'adopt',
            secondArtifact.artifact.artifactId,
            '--into',
            'parent-A',
            '--audit-root',
            fixture.externalAuditRoot,
          ],
          fixture.repositoryRoot,
          human.dependencies,
        ),
      hasCode('INTERVENTION_ADOPTION_COUNT_MISMATCH'),
    );
    audit = scanAuthorityAuditLedger(fixture.auditScope);
    assert.equal(audit.recordCount, 4);
  } finally {
    fixture.cleanup();
  }
});

test('artifact candidate drift is rejected before adoption state mutates', () => {
  const fixture = fixtureRepository();
  try {
    createParentWip(fixture);
    const human = humanDependencies(fixture);
    const intervention = intervene(fixture, human.dependencies).intervention!;
    const persisted = persistArtifact(
      fixture,
      intervention.childWorkspace.childWorkspacePath,
      true,
      'engine-drift',
    );
    fs.appendFileSync(persisted.executablePath, '// drift\n');
    assert.throws(
      () =>
        dispatchBootstrapInterventionCommand(
          [
            'engine',
            'adopt',
            persisted.artifact.artifactId,
            '--into',
            'parent-A',
            '--audit-root',
            fixture.externalAuditRoot,
          ],
          fixture.repositoryRoot,
          human.dependencies,
        ),
      hasCode('INTERVENTION_ENGINE_ARTIFACT_DRIFT'),
    );
    assert.deepEqual(
      fs.readdirSync(path.join(fixture.stateRoot, 'adoptions')),
      [],
    );
    assert.equal(
      fs.existsSync(path.join(fixture.stateRoot, 'local-parent-sessions')),
      false,
    );
    const audit = scanAuthorityAuditLedger(fixture.auditScope);
    assert.equal(audit.recordCount, 3);
    assert.equal(audit.records.at(-1)?.record.eventType, 'error');
    assert.equal(audit.records.at(-1)?.record.result, 'failed');
    assert.equal(
      verifyAuthorityAuditEvents(fixture.auditScope).events.at(-1)?.event
        .errorCode,
      'INTERVENTION_ENGINE_ARTIFACT_DRIFT',
    );
  } finally {
    fixture.cleanup();
  }
});

test('reason mismatch refusal is audited once at the persisted grant root', () => {
  const fixture = fixtureRepository();
  try {
    createParentWip(fixture);
    const human = humanDependencies(fixture);
    intervene(fixture, human.dependencies);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assert.throws(
        () =>
          intervene(
            fixture,
            human.dependencies,
            'A different repair was requested.',
          ),
        hasCode('INTERVENTION_REASON_BINDING_MISMATCH'),
      );
    }
    const audit = scanAuthorityAuditLedger(fixture.auditScope);
    assert.equal(audit.recordCount, 3);
    assert.equal(audit.records.at(-1)?.record.eventType, 'error');
    assert.equal(audit.records.at(-1)?.record.result, 'failed');
    assert.equal(
      verifyAuthorityAuditEvents(fixture.auditScope).events.at(-1)?.event
        .errorCode,
      'INTERVENTION_REASON_BINDING_MISMATCH',
    );
  } finally {
    fixture.cleanup();
  }
});

test('adoption resumes after a crash and unhealthy E2 rolls the parent back to E1', () => {
  const crashFixture = fixtureRepository();
  try {
    createParentWip(crashFixture);
    const initial = humanDependencies(crashFixture);
    const intervention = intervene(
      crashFixture,
      initial.dependencies,
    ).intervention!;
    const persisted = persistArtifact(
      crashFixture,
      intervention.childWorkspace.childWorkspacePath,
      true,
      'engine-crash',
    );
    let crashes = 0;
    const crashing = humanDependencies(crashFixture, {
      afterAdoptionStep() {
        crashes += 1;
        throw new Error('simulated adoption crash');
      },
    });
    assert.throws(
      () =>
        dispatchBootstrapInterventionCommand(
          [
            'engine',
            'adopt',
            persisted.artifact.artifactId,
            '--into',
            'parent-A',
            '--audit-root',
            crashFixture.externalAuditRoot,
          ],
          crashFixture.repositoryRoot,
          crashing.dependencies,
        ),
      /simulated adoption crash/,
    );
    assert.equal(crashes, 1);
    const resumed = dispatchBootstrapInterventionCommand(
      [
        'engine',
        'adopt',
        persisted.artifact.artifactId,
        '--into',
        'parent-A',
        '--audit-root',
        crashFixture.externalAuditRoot,
      ],
      crashFixture.repositoryRoot,
      humanDependencies(crashFixture).dependencies,
    );
    assert.equal(resumed.adoptionState, 'COMMITTED');
    assert.equal(resumed.parentSession?.blocker, null);
  } finally {
    crashFixture.cleanup();
  }

  const rollbackFixture = fixtureRepository();
  try {
    createParentWip(rollbackFixture);
    const human = humanDependencies(rollbackFixture);
    const intervention = intervene(
      rollbackFixture,
      human.dependencies,
    ).intervention!;
    const persisted = persistArtifact(
      rollbackFixture,
      intervention.childWorkspace.childWorkspacePath,
      false,
      'engine-unhealthy',
    );
    const rolledBack = dispatchBootstrapInterventionCommand(
      [
        'engine',
        'adopt',
        persisted.artifact.artifactId,
        '--into',
        'parent-A',
        '--audit-root',
        rollbackFixture.externalAuditRoot,
      ],
      rollbackFixture.repositoryRoot,
      human.dependencies,
    );
    assert.equal(rolledBack.adoptionState, 'ENGINE_BINDING_ROLLED_BACK');
    assert.equal(rolledBack.parentSession?.engineDigest, digest('engine-E1'));
    assert.equal(rolledBack.parentSession?.interventionState, 'active');
    assert.equal(
      rolledBack.parentSession?.blocker?.kind,
      'harness-intervention',
    );
    assert.equal(
      scanAuthorityAuditLedger(rollbackFixture.auditScope).records.at(-1)
        ?.record.result,
      'rolled-back',
    );
  } finally {
    rollbackFixture.cleanup();
  }
});

test('caller-supplied signed JSON routes and global promotion fail before any mutation', () => {
  const fixture = fixtureRepository();
  try {
    const before = fs.readdirSync(fixture.stateRoot);
    for (const argv of [
      ['worktree', 'parent-A', '--grant', 'must-not-be-read.json'],
      ['prepare-adoption', 'parent-A', '--request', 'must-not-be-read.json'],
      ['adopt', 'tx-1', '--request', 'must-not-be-read.json'],
      ['change', 'intervene', 'parent-A', '--request', 'must-not-be-read.json'],
      ['engine', 'adopt', '--request', 'must-not-be-read.json'],
    ]) {
      assert.throws(
        () =>
          dispatchBootstrapInterventionCommand(
            argv,
            fixture.repositoryRoot,
            {},
          ),
        hasCode('INTERVENTION_CALLER_SUPPLIED_MAINTENANCE_INPUT_DISABLED'),
      );
      assert.deepEqual(fs.readdirSync(fixture.stateRoot), before);
    }
    assert.throws(
      () =>
        dispatchBootstrapInterventionCommand(
          [
            'change',
            'intervene',
            'parent-A',
            '--reason',
            'Missing audit root.',
          ],
          fixture.repositoryRoot,
          {},
        ),
      hasCode('INTERVENTION_AUTHORITY_AUDIT_ROOT_REQUIRED'),
    );
    assert.deepEqual(fs.readdirSync(fixture.stateRoot), before);
    assert.throws(
      () =>
        dispatchBootstrapInterventionCommand(
          ['promote', digest('engine-E2')],
          fixture.repositoryRoot,
          {},
        ),
      hasCode('INTERVENTION_BOOTSTRAP_GLOBAL_PROMOTION_FORBIDDEN'),
    );
    assert.deepEqual(fs.readdirSync(fixture.stateRoot), before);
    assert.match(
      bootstrapInterventionUsage(),
      /engine adopt <artifact-id> --into <parent-change-id>/,
    );
    assert.doesNotMatch(bootstrapInterventionUsage(), /--grant/);
  } finally {
    fixture.cleanup();
  }
});

test('production build-artifact persists a derived candidate and E2 reloads the checkpoint before health', () => {
  const fixture = fixtureRepository();
  try {
    createParentWip(fixture);
    const human = humanDependencies(fixture);
    const intervention = intervene(fixture, human.dependencies).intervention!;
    const engineDirectory = path.join(
      intervention.childWorkspace.childWorkspacePath,
      'packages/workflow-engine',
    );
    fs.mkdirSync(engineDirectory, { recursive: true });
    const executable = writeEngineExecutable(
      engineDirectory,
      true,
      'engine-E2',
    );
    const built = dispatchBootstrapInterventionCommand(
      [
        'engine',
        'build-artifact',
        executable.executablePath,
        '--for',
        'parent-A',
        '--protocol-version',
        '3',
        '--policy-schema-version',
        '2',
        '--audit-root',
        fixture.externalAuditRoot,
      ],
      fixture.repositoryRoot,
      human.dependencies,
    );
    assert.equal(built.action, 'engine-build-artifact');
    assert.equal(built.engineArtifact?.parentChangeId, 'parent-A');
    const artifactId = built.engineArtifact!.artifact.artifactId;
    assert.deepEqual(
      readInterventionEngineArtifact(fixture.stateRoot, artifactId),
      built.engineArtifact,
    );

    // A may be clean after E1 stopped. E2 adoption must restore the exact P1
    // tracked, untracked, and durable session bytes before probing/health.
    git(fixture.repositoryRoot, ['reset', '--hard', 'HEAD']);
    fs.rmSync(path.join(fixture.repositoryRoot, 'note.bin'));
    fs.writeFileSync(fixture.sessionSnapshotPath, '{"checkpoint":"lost"}\n', {
      mode: 0o600,
    });
    const adopted = dispatchBootstrapInterventionCommand(
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
      human.dependencies,
    );
    assert.equal(adopted.adoptionState, 'COMMITTED');
    assert.equal(
      fs.readFileSync(path.join(fixture.repositoryRoot, 'tracked.txt'), 'utf8'),
      'wip\n',
    );
    assert.deepEqual(
      fs.readFileSync(path.join(fixture.repositoryRoot, 'note.bin')),
      Buffer.from([0, 1, 2, 255]),
    );
    assert.equal(
      fs.readFileSync(fixture.sessionSnapshotPath, 'utf8'),
      '{"checkpoint":"plan-review"}\n',
    );
  } finally {
    fixture.cleanup();
  }
});

test('rolled-back adoption does not consume the local success limit and a repaired artifact can retry', () => {
  const fixture = fixtureRepository();
  try {
    createParentWip(fixture);
    const human = humanDependencies(fixture);
    const intervention = intervene(fixture, human.dependencies).intervention!;
    const unhealthy = persistArtifact(
      fixture,
      intervention.childWorkspace.childWorkspacePath,
      false,
      'engine-unhealthy-first',
    );
    const first = dispatchBootstrapInterventionCommand(
      [
        'engine',
        'adopt',
        unhealthy.artifact.artifactId,
        '--into',
        'parent-A',
        '--audit-root',
        fixture.externalAuditRoot,
      ],
      fixture.repositoryRoot,
      human.dependencies,
    );
    assert.equal(first.adoptionState, 'ENGINE_BINDING_ROLLED_BACK');
    const expiredGrant = readMaintenanceGrantForParent(
      fixture.stateRoot,
      'parent-A',
    );
    const renewedHuman = humanDependencies(fixture, {
      now: new Date('2026-08-03T10:31:00.000Z'),
    });
    const renewedIntervention = intervene(fixture, renewedHuman.dependencies);
    assert.equal(renewedIntervention.effectsPerformed, false);
    const renewedGrant = readMaintenanceGrantForParent(
      fixture.stateRoot,
      'parent-A',
    );
    assert.equal(renewedGrant.state, 'available');
    assert.notEqual(
      renewedGrant.envelope.payload.grantId,
      expiredGrant.envelope.payload.grantId,
    );

    const repaired = persistArtifact(
      fixture,
      intervention.childWorkspace.childWorkspacePath,
      true,
      'engine-healthy-second',
    );
    const second = dispatchBootstrapInterventionCommand(
      [
        'engine',
        'adopt',
        repaired.artifact.artifactId,
        '--into',
        'parent-A',
        '--audit-root',
        fixture.externalAuditRoot,
      ],
      fixture.repositoryRoot,
      renewedHuman.dependencies,
    );
    assert.equal(second.adoptionState, 'COMMITTED');
    assert.equal(second.parentSession?.engineDigest, repaired.executableDigest);
    assert.equal(second.parentSession?.blocker, null);
    assert.equal(second.parentSession?.interventionState, 'adopted');
  } finally {
    fixture.cleanup();
  }
});

test('recover accepts binding-updated journal-behind crash and adoption resumes deterministically', () => {
  const fixture = fixtureRepository();
  try {
    createParentWip(fixture);
    const initial = humanDependencies(fixture);
    const intervention = intervene(fixture, initial.dependencies).intervention!;
    const persisted = persistArtifact(
      fixture,
      intervention.childWorkspace.childWorkspacePath,
      true,
      'engine-binding-cas-crash',
    );
    const crashing = humanDependencies(fixture, {
      afterBindingUpdatedBeforeJournal() {
        throw new Error('simulated binding CAS crash');
      },
    });
    assert.throws(
      () =>
        dispatchBootstrapInterventionCommand(
          [
            'engine',
            'adopt',
            persisted.artifact.artifactId,
            '--into',
            'parent-A',
            '--audit-root',
            fixture.externalAuditRoot,
          ],
          fixture.repositoryRoot,
          crashing.dependencies,
        ),
      /simulated binding CAS crash/,
    );
    const adoptions = fs.readdirSync(path.join(fixture.stateRoot, 'adoptions'));
    assert.equal(adoptions.length, 1);
    const txId = adoptionTransactionIdForTest(
      'parent-A',
      persisted.artifact.artifactId,
    );
    const recovered = dispatchBootstrapInterventionCommand(
      ['recover', txId],
      fixture.repositoryRoot,
      humanDependencies(fixture).dependencies,
    );
    assert.equal(recovered.adoptionState, 'PARENT_CHECKPOINTED');
    assert.equal(recovered.decision?.action, 'update-engine-binding');
    assert.equal(
      recovered.parentSession?.engineDigest,
      persisted.executableDigest,
    );
    const resumed = dispatchBootstrapInterventionCommand(
      [
        'engine',
        'adopt',
        persisted.artifact.artifactId,
        '--into',
        'parent-A',
        '--audit-root',
        fixture.externalAuditRoot,
      ],
      fixture.repositoryRoot,
      humanDependencies(fixture).dependencies,
    );
    assert.equal(resumed.adoptionState, 'COMMITTED');
  } finally {
    fixture.cleanup();
  }
});

test('human revoke durably abandons a rolled-back intervention and clears the active projection', () => {
  const fixture = fixtureRepository();
  try {
    createParentWip(fixture);
    const human = humanDependencies(fixture);
    const intervention = intervene(fixture, human.dependencies).intervention!;
    const unhealthy = persistArtifact(
      fixture,
      intervention.childWorkspace.childWorkspacePath,
      false,
      'engine-abandoned',
    );
    const rolledBack = dispatchBootstrapInterventionCommand(
      [
        'engine',
        'adopt',
        unhealthy.artifact.artifactId,
        '--into',
        'parent-A',
        '--audit-root',
        fixture.externalAuditRoot,
      ],
      fixture.repositoryRoot,
      human.dependencies,
    );
    assert.equal(rolledBack.adoptionState, 'ENGINE_BINDING_ROLLED_BACK');
    assert.equal(fs.existsSync(rolledBack.bindingPath!), true);

    const revokeArgs = [
      'change',
      'revoke-intervention',
      'parent-A',
      '--reason',
      'Maintainer abandoned the failed repair.',
    ];
    assert.throws(
      () =>
        dispatchBootstrapInterventionCommand(
          revokeArgs,
          fixture.repositoryRoot,
          humanDependencies(fixture, {
            afterAbandonmentIntentPersisted() {
              throw new Error('simulated abandonment crash');
            },
          }).dependencies,
        ),
      /simulated abandonment crash/,
    );
    assert.equal(fs.existsSync(rolledBack.bindingPath!), true);
    assert.equal(
      readPersistedIntervention(fixture.stateRoot, 'parent-A').parent.blocker
        ?.kind,
      'harness-intervention',
    );
    assert.equal(
      readMaintenanceGrantForParent(fixture.stateRoot, 'parent-A').state,
      'revoked',
    );
    const revoked = dispatchBootstrapInterventionCommand(
      revokeArgs,
      fixture.repositoryRoot,
      human.dependencies,
    );
    assert.equal(revoked.effectsPerformed, true);
    assert.equal(fs.existsSync(rolledBack.bindingPath!), false);
    assert.throws(
      () => readPersistedIntervention(fixture.stateRoot, 'parent-A'),
      hasCode('INTERVENTION_PERSISTENCE_NOT_FOUND'),
    );
    assert.equal(
      readMaintenanceGrantForParent(fixture.stateRoot, 'parent-A').state,
      'revoked',
    );
    const replay = dispatchBootstrapInterventionCommand(
      revokeArgs,
      fixture.repositoryRoot,
      human.dependencies,
    );
    assert.equal(replay.effectsPerformed, false);
  } finally {
    fixture.cleanup();
  }
});

function adoptionTransactionIdForTest(
  parentChangeId: string,
  artifactId: `sha256:${string}`,
): string {
  return `adoption-${crypto
    .createHash('sha256')
    .update(`local-engine-adoption\0${parentChangeId}\0${artifactId}`)
    .digest('hex')}`;
}
