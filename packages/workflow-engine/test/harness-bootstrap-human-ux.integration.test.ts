import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { BUILT_IN_ENGINE_CLOSURE_MANIFEST_DIGEST } from '../bootstrap/built-in-engine-closure-pin.ts';
import { createEngineArtifact } from '../src/intervention-control.ts';
import { bootstrapInterventionStateRoot } from '../src/intervention-control-bootstrap-cli.ts';
import { readPersistedIntervention } from '../src/intervention-control-persistence.ts';
import {
  persistInterventionEngineArtifact,
  readMaintenanceGrantForParent,
} from '../src/intervention-maintenance.ts';

const NOW = new Date('2026-08-03T10:00:00.000Z');
const SOURCE_REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../../..');
const SOURCE_ENGINE_ROOT = path.join(
  SOURCE_REPOSITORY_ROOT,
  'packages',
  'workflow-engine',
);

function digest(value: string | Buffer): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function git(repositoryRoot: string, args: string[]): string {
  return childProcess.execFileSync('git', ['-C', repositoryRoot, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function fixture() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'sealed-human-bootstrap-')),
  );
  fs.chmodSync(root, 0o700);
  const repositoryRoot = path.join(root, 'parent');
  fs.mkdirSync(path.join(repositoryRoot, 'workflow'), {
    recursive: true,
    mode: 0o700,
  });
  fs.copyFileSync(
    path.join(SOURCE_REPOSITORY_ROOT, 'workflow', 'config.json'),
    path.join(repositoryRoot, 'workflow', 'config.json'),
  );
  fs.writeFileSync(path.join(repositoryRoot, 'tracked.txt'), 'base\n');
  git(repositoryRoot, ['init', '-b', 'work/parent-A']);
  git(repositoryRoot, ['config', 'user.email', 'workflow@example.test']);
  git(repositoryRoot, ['config', 'user.name', 'Workflow Test']);
  // Parent recovery state comes from the durable session; HEAD supplies only
  // the fail-closed human-signer trust root required to issue a new grant.
  const origin = 'https://github.com/example/sealed-bootstrap-fixture.git';
  git(repositoryRoot, ['remote', 'add', 'origin', origin]);
  fs.writeFileSync(
    path.join(repositoryRoot, 'workflow', 'maintainer-policy.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        repository: {
          id: 'github:R_sealed_bootstrap_fixture',
          origin,
        },
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
  git(repositoryRoot, ['add', '.']);
  git(repositoryRoot, ['commit', '-m', 'Create durable parent fixture']);
  const repositoryRealPath = fs.realpathSync(repositoryRoot);
  const gitCommonDirectory = fs.realpathSync(
    git(repositoryRoot, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ]).trim(),
  );
  const runtimeRoot = path.join(gitCommonDirectory, 'workflow-engine');
  const sessions = path.join(runtimeRoot, 'sessions');
  fs.mkdirSync(sessions, { recursive: true, mode: 0o700 });
  const head = git(repositoryRoot, ['rev-parse', 'HEAD']).trim();
  const tree = git(repositoryRoot, ['rev-parse', 'HEAD^{tree}']).trim();
  const sessionId = 'session-parent-A-durable';
  fs.writeFileSync(
    path.join(sessions, `${sessionId}.json`),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        sessionId,
        state: 'active',
        changeId: 'parent-A',
        taskId: '1.1',
        repositoryRoot: repositoryRealPath,
        gitCommonDirectory,
        branch: 'work/parent-A',
        baseline: { head, tree },
        artifacts: { guard: digest('guard-parent-A') },
        allowedPaths: ['packages/workflow-engine/**'],
        requiredChecks: ['workflow-engine-test'],
        requiredCheckDigests: {
          'workflow-engine-test': digest('workflow-engine-test-definition'),
        },
        createdAt: NOW.toISOString(),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  fs.writeFileSync(path.join(repositoryRoot, 'tracked.txt'), 'blocked-wip\n');
  fs.writeFileSync(
    path.join(repositoryRoot, 'note.bin'),
    Buffer.from([0, 1, 2]),
  );
  const stateRoot = bootstrapInterventionStateRoot(gitCommonDirectory);
  const externalAuditRoot = path.join(root, 'authority-audit');
  const isolatedPackage = path.join(root, 'sealed-package');
  const isolatedRuntime = path.join(
    isolatedPackage,
    'bootstrap',
    'recovery-runtime',
  );
  fs.mkdirSync(path.dirname(isolatedRuntime), { recursive: true });
  fs.cpSync(
    path.join(SOURCE_ENGINE_ROOT, 'bootstrap', 'recovery-runtime'),
    isolatedRuntime,
    { recursive: true },
  );
  fs.writeFileSync(
    path.join(isolatedPackage, 'package.json'),
    `${JSON.stringify({ type: 'module' })}\n`,
  );
  const helperPath = path.join(root, 'invoke-sealed-bootstrap.mjs');
  const harnessUrl = pathToFileURL(
    path.join(isolatedRuntime, 'src', 'harness-bootstrap.js'),
  ).href;
  fs.writeFileSync(
    helperPath,
    `import { runHarnessBootstrapCli } from ${JSON.stringify(harnessUrl)};
const [action, repositoryRoot, auditRoot, artifactId = ''] = process.argv.slice(2);
const signer = {
  assertHumanPresent() { process.stderr.write('TEST_TTY_ASSERTED\\n'); },
  identity() { return 'maintainer@example.test'; },
  sign() { process.stderr.write('TEST_SIGNATURE_CREATED\\n'); return 'sealed-human-signature'; },
  verify() {},
};
const argv = action === 'intervene'
  ? ['change', 'intervene', 'parent-A', '--reason', 'Repair E1 from the sealed bootstrap.', '--audit-root', auditRoot, '--json']
  : ['engine', 'adopt', artifactId, '--into', 'parent-A', '--audit-root', auditRoot, '--json'];
process.exitCode = runHarnessBootstrapCli(argv, repositoryRoot, {
  now: () => new Date(${JSON.stringify(NOW.toISOString())}),
  maintenanceSigner: signer,
  presentMaintenanceSummary(summary) { process.stderr.write(summary.humanReadable + '\\n'); },
});
`,
    { mode: 0o700 },
  );
  return {
    root,
    repositoryRoot,
    stateRoot,
    externalAuditRoot,
    helperPath,
    run(action: 'intervene' | 'adopt', artifactId?: string) {
      return childProcess.spawnSync(
        process.execPath,
        [
          helperPath,
          action,
          repositoryRoot,
          externalAuditRoot,
          artifactId ?? '',
        ],
        { encoding: 'utf8', cwd: root },
      );
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function engineExecutable(sessionSchema: string) {
  return `#!/usr/bin/env node
const mode = process.argv[2];
if (mode === '--bootstrap-probe') {
  process.stdout.write(JSON.stringify({kind:'engine-bootstrap-probe.v1',started:true,sessionSchema:${JSON.stringify(sessionSchema)}}) + '\\n');
  process.exit(0);
}
if (mode === '--health-check') {
  process.stdout.write(JSON.stringify({kind:'engine-health.v1',healthy:true,sessionSchema:${JSON.stringify(sessionSchema)}}) + '\\n');
  process.exit(0);
}
process.exit(2);
`;
}

test('sealed direct bootstrap derives the parent only from durable session state and adopts without mutable E1', () => {
  const value = fixture();
  try {
    const intervened = value.run('intervene');
    assert.equal(intervened.status, 0, intervened.stderr);
    assert.match(intervened.stderr, /TEST_TTY_ASSERTED/);
    assert.match(intervened.stderr, /TEST_SIGNATURE_CREATED/);
    assert.match(intervened.stderr, /Exact scope paths:/);
    const interventionOutput = JSON.parse(intervened.stdout) as {
      ok: boolean;
      result: { action: string; effectsPerformed: boolean };
    };
    assert.equal(interventionOutput.ok, true);
    assert.equal(interventionOutput.result.action, 'intervene');
    assert.equal(interventionOutput.result.effectsPerformed, true);
    const intervention = readPersistedIntervention(value.stateRoot, 'parent-A');
    const grant = readMaintenanceGrantForParent(value.stateRoot, 'parent-A');
    assert.equal(
      intervention.parent.engineBinding,
      BUILT_IN_ENGINE_CLOSURE_MANIFEST_DIGEST,
    );
    assert.equal(intervention.parent.sessionSchema, 'workflow-session.v1');
    assert.equal(
      grant.envelope.payload.reason,
      'Repair E1 from the sealed bootstrap.',
    );

    const source = engineExecutable(intervention.parent.sessionSchema);
    const executablePath = path.join(
      intervention.childWorkspace.childWorkspacePath,
      'engine-probe.mjs',
    );
    fs.writeFileSync(executablePath, source, { mode: 0o755 });
    const artifact = createEngineArtifact({
      sourceChangeId: intervention.relationship.interventionChangeId,
      sourceDigest: digest('sealed-E2-source'),
      executableDigest: digest(source),
      protocolVersion: 3,
      canReadSessionSchemas: [intervention.parent.sessionSchema],
      writesSessionSchema: intervention.parent.sessionSchema,
      policySchemaVersion: 2,
      smokeReportDigest: digest('sealed-E2-smoke'),
    });
    persistInterventionEngineArtifact(value.stateRoot, {
      parentChangeId: 'parent-A',
      artifact,
      executablePath,
      now: NOW,
    });
    const adopted = value.run('adopt', artifact.artifactId);
    assert.equal(adopted.status, 0, adopted.stderr);
    assert.doesNotMatch(adopted.stderr, /TEST_SIGNATURE_CREATED/);
    const adoptionOutput = JSON.parse(adopted.stdout) as {
      ok: boolean;
      result: {
        action: string;
        adoptionState: string;
        effectsPerformed: boolean;
      };
    };
    assert.equal(adoptionOutput.ok, true);
    assert.equal(adoptionOutput.result.action, 'engine-adopt');
    assert.equal(adoptionOutput.result.adoptionState, 'COMMITTED');
    assert.equal(adoptionOutput.result.effectsPerformed, true);
    assert.equal(
      fs.existsSync(path.join(value.root, 'sealed-package', 'src')),
      false,
    );
  } finally {
    value.cleanup();
  }
});
