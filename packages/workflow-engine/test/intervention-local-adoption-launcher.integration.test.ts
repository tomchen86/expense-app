import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  capturePersistedWipIntervention,
  executePersistedAdoptionStep,
  initializeLocalEngineBinding,
  materializeInterventionChildWorktree,
  readLocalEngineBinding,
} from '../src/application/control-plane/intervention-control-bootstrap.ts';
import { createEngineArtifact } from '../src/modules/authority/intervention-control.ts';
import { persistInterventionEngineArtifact } from '../src/application/control-plane/intervention-maintenance.ts';
import { preparePersistedEngineAdoption } from '../src/intervention-control-persistence.ts';
import { setupInitialControlPlaneBootstrapFixture } from './control-plane-promotion-fixture.ts';

const NOW = new Date('2026-08-03T10:00:00.000Z');
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
      assert.equal(signature, 'local-adoption-human-signature');
      assert.equal(namespace, 'expense-app.harness-maintenance-grant.v1');
      return true;
    },
  };
}

async function fixture(healthy = true) {
  const controlPlane = await setupInitialControlPlaneBootstrapFixture({
    builtInEntrypointBytes: repositoryDefaultEngineSource(),
    now: NOW,
  });
  const workspacePrefix = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'local-adoption-launcher-')),
  );
  fs.rmdirSync(workspacePrefix);
  const repository = fs.realpathSync(controlPlane.repository);
  const child = `${workspacePrefix}-child`;
  const otherParent = `${workspacePrefix}-other-parent`;
  const wrongParent = `${workspacePrefix}-wrong-parent`;
  const stateRoot = controlPlane.stateRoot;
  git(repository, ['checkout', '-b', 'work/parent-A']);
  const sessionPath = path.join(stateRoot, 'parent-session-snapshot.json');
  fs.writeFileSync(sessionPath, '{"step":"P1"}\n', { mode: 0o600 });
  const fromEngineDigest =
    controlPlane.initialized.activeArtifact.executableDigest;
  const captured = capturePersistedWipIntervention(stateRoot, {
    repositoryRoot: repository,
    parent: {
      changeId: 'parent-A',
      status: 'active',
      engineBinding: fromEngineDigest,
      sessionSchema: 'v4',
      blocker: null,
    },
    interventionChangeId: 'intervention-B',
    childWorkspacePath: child,
    changeRef: 'refs/heads/work/intervention-B',
    untrackedAllowlist: [],
    sessionSnapshotPath: sessionPath,
    pendingIntent: 'Resume parent-A at P1 under the adopted engine.',
    policyDigest: digest('policy-E1'),
    now: NOW,
  });
  const envelope = {
    payload: {
      kind: 'harness-maintenance-grant.v1' as const,
      grantId: `local-adoption-${healthy ? 'healthy' : 'unhealthy'}`,
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
      engineFromDigest: fromEngineDigest,
      sessionSchema: 'v4',
      maxLocalAdoptions: 1,
      issuedAt: '2026-08-03T09:55:00.000Z',
      expiresAt: '2026-08-03T11:00:00.000Z',
      humanSigner: 'maintainer@example.test',
      reason: 'Adopt a bounded session-local E2.',
    },
    signature: 'local-adoption-human-signature',
  };
  materializeInterventionChildWorktree(
    stateRoot,
    {
      parentChangeId: 'parent-A',
      repositoryRoot: repository,
      maintenanceGrantEnvelope: envelope,
    },
    dependencies(),
  );
  const executablePath = path.join(child, 'engine-probe.mjs');
  const source = engineSource(healthy);
  fs.writeFileSync(executablePath, source, { mode: 0o755 });
  const artifact = createEngineArtifact({
    sourceChangeId: 'intervention-B',
    sourceDigest: digest('source-E2'),
    executableDigest: digest(source),
    protocolVersion: 3,
    canReadSessionSchemas: ['v4'],
    writesSessionSchema: 'v4',
    policySchemaVersion: 2,
    smokeReportDigest: digest(`smoke:${healthy}`),
  });
  persistInterventionEngineArtifact(stateRoot, {
    parentChangeId: 'parent-A',
    artifact,
    executablePath,
    now: NOW,
  });
  const txId = `local-adoption-${healthy ? 'healthy' : 'unhealthy'}-tx`;
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
  const bindingPath = parentBindingPath(stateRoot, 'parent-A');
  const materializedExecutablePath = path.join(
    stateRoot,
    'local-engine-artifacts',
    artifact.artifactId.slice('sha256:'.length),
    'engine',
  );
  initializeLocalEngineBinding(stateRoot, bindingPath, {
    parentChangeId: 'parent-A',
    parentWorkspacePath: repository,
    parentBranch: 'refs/heads/work/parent-A',
    interventionChangeId: 'intervention-B',
    txId,
    checkpointId: captured.intervention.checkpoint.checkpointId,
    engineDigest: fromEngineDigest,
    artifactId: artifact.artifactId,
    executableDigest: artifact.executableDigest,
    executablePath: materializedExecutablePath,
    sessionSchema: 'v4',
    now: NOW,
  });
  let journalDigest = adoption.journal.journalDigest;

  return {
    repository,
    child,
    otherParent,
    wrongParent,
    stateRoot,
    bindingPath,
    materializedExecutablePath,
    checkpointId: captured.intervention.checkpoint.checkpointId,
    artifact,
    executablePath,
    txId,
    step(index: number) {
      const at = new Date(NOW.getTime() + (index + 1) * 60_000).toISOString();
      const result = executePersistedAdoptionStep(
        stateRoot,
        {
          txId,
          expectedJournalDigest: journalDigest,
          bindingPath,
          artifact,
          executablePath,
          at,
        },
        dependencies(new Date(at)),
      );
      journalDigest = result.record.journal.journalDigest;
      return result;
    },
    complete() {
      let result: ReturnType<typeof executePersistedAdoptionStep> | undefined;
      for (let index = 0; index < 5; index += 1) result = this.step(index);
      return result!;
    },
    cleanup() {
      controlPlane.cleanup();
      for (const target of [child, otherParent, wrongParent]) {
        fs.rmSync(target, { recursive: true, force: true });
      }
    },
  };
}

function engineSource(healthy: boolean): string {
  return `#!/usr/bin/env node
const mode = process.argv[2];
if (mode === '--bootstrap-probe') {
  process.stdout.write(JSON.stringify({kind:'engine-bootstrap-probe.v1',started:true,sessionSchema:'v4'}) + '\\n');
  process.exit(0);
}
if (mode === '--health-check') {
  process.stdout.write(JSON.stringify({kind:'engine-health.v1',healthy:${healthy ? 'true' : 'false'},sessionSchema:'v4'}) + '\\n');
  process.exit(0);
}
const resume = process.env.WORKFLOW_LOCAL_ENGINE_RESUME_BINDING;
process.stdout.write(JSON.stringify({
  kind:'local-adopted-engine.v1',
  engine:'E2',
  argv:process.argv.slice(2),
  resume:resume === undefined ? null : JSON.parse(resume),
  leakedTxId:process.env.WORKFLOW_LOCAL_ENGINE_TX_ID ?? null,
  leakedChild:process.env.WORKFLOW_LOCAL_ENGINE_CHILD_WORKTREE ?? null
}) + '\\n');
process.exit(mode === '--launcher-exit-7' ? 7 : 0);
`;
}

function repositoryDefaultEngineSource(): string {
  return `#!/usr/bin/env node
process.stdout.write(JSON.stringify({kind:'repository-default-engine.v1',engine:'Eglobal',argv:process.argv.slice(2)}) + '\\n');
process.exit(0);
`;
}

test('committed local adoption dispatches exact E2 on the next parent command and nowhere else', async () => {
  const value = await fixture(true);
  try {
    const terminal = value.complete();
    assert.equal(terminal.record.journal.state, 'COMMITTED');
    assert.equal(fs.existsSync(value.materializedExecutablePath), true);
    git(value.repository, ['worktree', 'remove', '--force', value.child]);
    assert.equal(fs.existsSync(value.child), false);

    const launched = runWorkflowLauncher(value.repository, [
      'ordinary-command',
      '--exact-argument',
    ]);
    assert.equal(launched.status, 0, launched.stderr);
    assert.deepEqual(JSON.parse(launched.stdout), {
      kind: 'local-adopted-engine.v1',
      engine: 'E2',
      argv: ['ordinary-command', '--exact-argument'],
      resume: {
        kind: 'local-engine-resume-binding.v1',
        parentChangeId: 'parent-A',
        checkpointId: value.checkpointId,
        engineDigest: value.artifact.executableDigest,
      },
      leakedTxId: null,
      leakedChild: null,
    });
    const exited = runWorkflowLauncher(value.repository, ['--launcher-exit-7']);
    assert.equal(exited.status, 7, exited.stderr);

    const other = value.otherParent;
    git(value.repository, [
      'worktree',
      'add',
      '-b',
      'work/parent-C',
      other,
      'HEAD',
    ]);
    const isolated = runWorkflowLauncher(other, ['--help']);
    assert.equal(isolated.status, 0, isolated.stderr);
    assert.equal(JSON.parse(isolated.stdout).engine, 'Eglobal');

    git(value.repository, ['checkout', '--detach']);
    const detached = runWorkflowLauncher(value.repository, ['--help']);
    assert.equal(detached.status, 0, detached.stderr);
    assert.equal(JSON.parse(detached.stdout).engine, 'Eglobal');
    git(value.repository, ['checkout', 'work/parent-A']);
    assert.equal(
      JSON.parse(
        runWorkflowLauncher(value.repository, ['ordinary-command']).stdout,
      ).engine,
      'E2',
    );
  } finally {
    value.cleanup();
  }
});

test('mid-transaction local adoption fails ordinary dispatch closed', async () => {
  const value = await fixture(true);
  try {
    const first = value.step(0);
    assert.equal(first.record.journal.state, 'PARENT_CHECKPOINTED');
    const launched = runWorkflowLauncher(value.repository, ['--help']);
    assert.notEqual(launched.status, 0);
    assert.equal(launched.stdout, '');
    assert.match(launched.stderr, /WORKFLOW_LOCAL_ADOPTION_INCOMPLETE/);
  } finally {
    value.cleanup();
  }
});

test('binding-first crash windows fail closed and direct recovery reaches committed E2', async () => {
  const value = await fixture(true);
  try {
    value.step(0);
    rewriteCanonicalRecord(value.bindingPath, (binding) => {
      binding.engineDigest = value.artifact.executableDigest;
      binding.generation = 2;
    });
    const switchedAhead = runWorkflowLauncher(value.repository, ['--help']);
    assert.notEqual(switchedAhead.status, 0);
    assert.match(switchedAhead.stderr, /WORKFLOW_LOCAL_ADOPTION_INCOMPLETE/);
    value.step(1);
    value.step(2);
    value.step(3);

    rewriteCanonicalRecord(value.bindingPath, (binding) => {
      binding.generation = 3;
      binding.interventionState = 'adopted';
      binding.blocker = null;
    });
    const finalizedAhead = runWorkflowLauncher(value.repository, ['--help']);
    assert.notEqual(finalizedAhead.status, 0);
    assert.match(finalizedAhead.stderr, /WORKFLOW_LOCAL_ADOPTION_INCOMPLETE/);
    const committed = value.step(4);
    assert.equal(committed.record.journal.state, 'COMMITTED');
    const launched = runWorkflowLauncher(value.repository, [
      'ordinary-command',
    ]);
    assert.equal(launched.status, 0, launched.stderr);
    assert.equal(JSON.parse(launched.stdout).engine, 'E2');
  } finally {
    value.cleanup();
  }
});

test('unhealthy rolled-back adoption keeps the parent on repository default with its blocker', async () => {
  const value = await fixture(false);
  try {
    const terminal = value.complete();
    assert.equal(terminal.record.journal.state, 'ENGINE_BINDING_ROLLED_BACK');
    const binding = readLocalEngineBinding(value.bindingPath);
    assert.equal(binding.interventionState, 'active');
    assert.notEqual(binding.blocker, null);
    const launched = runWorkflowLauncher(value.repository, ['--help']);
    assert.equal(launched.status, 0, launched.stderr);
    assert.equal(JSON.parse(launched.stdout).engine, 'Eglobal');
  } finally {
    value.cleanup();
  }
});

test('committed local adoption fails closed for artifact, binding, and journal tampering', async () => {
  for (const [name, tamper, code] of [
    [
      'artifact',
      (value: Awaited<ReturnType<typeof fixture>>) => {
        fs.chmodSync(value.materializedExecutablePath, 0o700);
        fs.appendFileSync(value.materializedExecutablePath, '\n// tampered\n');
        fs.chmodSync(value.materializedExecutablePath, 0o500);
      },
      /WORKFLOW_LOCAL_ADOPTION_ARTIFACT_DIGEST_MISMATCH/,
    ],
    [
      'binding',
      (value: Awaited<ReturnType<typeof fixture>>) => {
        rewriteCanonicalRecord(value.bindingPath, (binding) => {
          binding.parentWorkspacePath = value.wrongParent;
        });
      },
      /WORKFLOW_LOCAL_ADOPTION_BINDING_MISMATCH/,
    ],
    [
      'journal',
      (value: Awaited<ReturnType<typeof fixture>>) => {
        fs.appendFileSync(adoptionPath(value.stateRoot, value.txId), ' ');
      },
      /WORKFLOW_LOCAL_ADOPTION_JOURNAL_CORRUPT/,
    ],
  ] as const) {
    const value = await fixture(true);
    try {
      value.complete();
      tamper(value);
      const launched = runWorkflowLauncher(value.repository, ['--help']);
      assert.notEqual(launched.status, 0, name);
      assert.equal(launched.stdout, '', name);
      assert.match(launched.stderr, code, name);
    } finally {
      value.cleanup();
    }
  }
});

test('sealed harness-bootstrap runtime remains usable when the mutable E1 src tree is broken', async () => {
  const value = await fixture(true);
  const isolatedPackage = fs.mkdtempSync(
    path.join(os.tmpdir(), 'harness-bootstrap-sealed-runtime-'),
  );
  try {
    value.complete();
    const rootPackage = JSON.parse(
      fs.readFileSync(
        path.join(SOURCE_REPOSITORY_ROOT, 'package.json'),
        'utf8',
      ),
    ) as { scripts: Record<string, string> };
    const enginePackage = JSON.parse(
      fs.readFileSync(
        path.join(
          SOURCE_REPOSITORY_ROOT,
          'packages',
          'workflow-engine',
          'package.json',
        ),
        'utf8',
      ),
    ) as { scripts: Record<string, string> };
    assert.equal(
      rootPackage.scripts['harness-bootstrap'],
      'node --experimental-strip-types packages/workflow-engine/bootstrap/harness-bootstrap-launcher.ts',
    );
    assert.equal(
      enginePackage.scripts['harness-bootstrap'],
      'node --experimental-strip-types bootstrap/harness-bootstrap-launcher.ts',
    );
    const engineRoot = path.join(
      isolatedPackage,
      'packages',
      'workflow-engine',
    );
    fs.mkdirSync(engineRoot, { recursive: true });
    fs.cpSync(
      path.join(
        SOURCE_REPOSITORY_ROOT,
        'packages',
        'workflow-engine',
        'bootstrap',
      ),
      path.join(engineRoot, 'bootstrap'),
      { recursive: true },
    );
    fs.writeFileSync(
      path.join(engineRoot, 'package.json'),
      `${JSON.stringify({ type: 'module' })}\n`,
    );
    fs.mkdirSync(path.join(engineRoot, 'src'));
    fs.writeFileSync(
      path.join(engineRoot, 'src', 'errors.ts'),
      `throw new Error('mutable E1 source must not load');\n`,
    );
    const status = childProcess.spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        path.join(engineRoot, 'bootstrap', 'harness-bootstrap-launcher.ts'),
        'status',
        'parent-A',
        '--tx',
        value.txId,
        '--json',
      ],
      { cwd: value.repository, encoding: 'utf8' },
    );
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).result.adoptionState, 'COMMITTED');
    fs.appendFileSync(
      path.join(
        engineRoot,
        'bootstrap',
        'recovery-runtime',
        'src',
        'errors.js',
      ),
      '\n// tampered\n',
    );
    const tampered = childProcess.spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        path.join(engineRoot, 'bootstrap', 'harness-bootstrap-launcher.ts'),
        'status',
        'parent-A',
        '--json',
      ],
      { cwd: value.repository, encoding: 'utf8' },
    );
    assert.notEqual(tampered.status, 0);
    assert.equal(tampered.stdout, '');
    assert.match(tampered.stderr, /HARNESS_BOOTSTRAP_RUNTIME_CLOSURE_MISMATCH/);

    const closure = JSON.parse(
      fs.readFileSync(
        path.join(
          SOURCE_REPOSITORY_ROOT,
          'packages',
          'workflow-engine',
          'bootstrap',
          'harness-bootstrap-dependency-closure.json',
        ),
        'utf8',
      ),
    ) as {
      entrypoint: string;
      boundary: string;
      claim: string;
      files: Array<{ path: string }>;
    };
    assert.equal(
      closure.entrypoint,
      'bootstrap/recovery-runtime/src/harness-bootstrap.js',
    );
    assert.equal(closure.boundary, 'sealed-e1-independent-recovery-runtime');
    assert.match(closure.claim, /independent/i);
    assert.equal(
      closure.files.some((entry) => entry.path.startsWith('src/')),
      false,
    );
  } finally {
    value.cleanup();
    fs.rmSync(isolatedPackage, { recursive: true, force: true });
  }
});

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

function adoptionPath(stateRoot: string, txId: string): string {
  const identity = crypto
    .createHash('sha256')
    .update(`adoption\0${txId}`)
    .digest('hex');
  return path.join(stateRoot, 'adoptions', `${identity}.json`);
}

function rewriteCanonicalRecord(
  filePath: string,
  mutate: (value: Record<string, unknown>) => void,
): void {
  const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<
    string,
    unknown
  >;
  mutate(value);
  delete value.recordDigest;
  value.recordDigest = digest(canonicalJson(value));
  fs.writeFileSync(filePath, `${canonicalJson(value)}\n`, { mode: 0o600 });
}
