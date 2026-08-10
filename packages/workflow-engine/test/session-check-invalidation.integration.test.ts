import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readImmutableReport } from '../src/report-store.ts';
import {
  capturePersistedWipIntervention,
  executePersistedAdoptionStep,
  initializeLocalEngineBinding,
  localEngineArtifactPath,
} from '../src/intervention-control-bootstrap.ts';
import { createEngineArtifact } from '../src/intervention-control.ts';
import { persistInterventionEngineArtifact } from '../src/intervention-maintenance.ts';
import { preparePersistedEngineAdoption } from '../src/intervention-control-persistence.ts';
import { resolveHarnessBootstrapParentState } from '../src/harness-bootstrap.ts';
import { checkSession, getSession, startSession } from '../src/session.ts';
import {
  configureChecks,
  createFixtureRepository,
  git,
  isWorkflowError,
  runtimeRoot,
} from './fixture.ts';

const NOW = new Date('2026-08-04T01:00:00.000Z');

test('local engine adoption selectively invalidates trusted harness-engine check evidence', () => {
  const repository = fs.realpathSync(createFixtureRepository());
  const countersRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-selective-check-counters-'),
  );
  const sourceCounter = path.join(countersRoot, 'source-only.log');
  const engineCounter = path.join(countersRoot, 'engine-dependent.log');
  try {
    installCountingChecks(repository, sourceCounter, engineCounter);
    installTrustedCheckDependencies(repository);
    git(repository, ['checkout', '-b', 'work/demo-change']);

    const session = startSession(repository, 'demo-change', '1.1');
    fs.writeFileSync(
      path.join(repository, 'src/feature.ts'),
      'export const feature = true;\n',
    );
    weakenCandidateDependencyDeclaration(repository);

    const original = checkSession(repository, session.sessionId);
    assert.deepEqual(readCounts(sourceCounter, engineCounter), {
      source: 1,
      engine: 1,
    });

    const adoption = adoptLocalEngine(repository, session.sessionId);
    const reportsRoot = path.join(runtimeRoot(repository), 'reports');
    const reportDirectory = path.join(reportsRoot, session.sessionId);
    let crashInjected = false;
    assert.throws(
      () =>
        withResumeBinding(adoption.resumeBinding, () =>
          checkSession(repository, session.sessionId, {
            testAfterReconciliationReport: () => {
              crashInjected = true;
              throw new Error('simulated reconciliation crash');
            },
          }),
        ),
      /simulated reconciliation crash/,
    );
    assert.equal(crashInjected, true);
    assert.equal(
      getSession(repository, session.sessionId).latestCheckReportId,
      original.reportId,
    );
    assert.deepEqual(readCounts(sourceCounter, engineCounter), {
      source: 1,
      engine: 2,
    });
    const reportsAfterCrash = fs.readdirSync(reportDirectory).sort();

    const reconciled = withResumeBinding(adoption.resumeBinding, () =>
      checkSession(repository, session.sessionId),
    ) as ReturnType<typeof checkSession> & {
      executedCheckIds: string[];
      reusedCheckIds: string[];
    };
    assert.deepEqual(reconciled.executedCheckIds, ['engine-check']);
    assert.deepEqual(reconciled.reusedCheckIds, ['source-check']);
    assert.deepEqual(readCounts(sourceCounter, engineCounter), {
      source: 1,
      engine: 3,
    });
    assert.deepEqual(fs.readdirSync(reportDirectory).sort(), reportsAfterCrash);

    const durable = getSession(repository, session.sessionId) as ReturnType<
      typeof getSession
    > & { checkEvidenceEngineDigest: string };
    assert.equal(durable.latestCheckReportId, reconciled.reportId);
    assert.equal(
      durable.checkEvidenceEngineDigest,
      adoption.resumeBinding.engineDigest,
    );
    const report = readImmutableReport(
      reportsRoot,
      session.sessionId,
      reconciled.reportId,
    );
    assert.equal(report.reconciledFromReportId, original.reportId);
    assert.deepEqual(report.selectiveInvalidation, {
      schemaVersion: 1,
      kind: 'local-engine-check-invalidation.v1',
      adoptionTxId: adoption.txId,
      checkpointId: adoption.resumeBinding.checkpointId,
      fromEngineDigest: adoption.fromEngineDigest,
      toEngineDigest: adoption.resumeBinding.engineDigest,
      changedDependencies: ['harness-engine'],
      invalidatedCheckIds: ['engine-check'],
      reusedCheckIds: ['source-check'],
      checkDependencies: {
        'engine-check': ['harness-engine', 'runner', 'source-tree'],
        'source-check': ['runner', 'source-tree'],
      },
    });
  } finally {
    fs.rmSync(interventionWorkspacePath(repository), {
      recursive: true,
      force: true,
    });
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(countersRoot, { recursive: true, force: true });
  }
});

test('local engine adoption retains fresh external-state evidence bound to the same snapshot', () => {
  const repository = fs.realpathSync(createFixtureRepository());
  const countersRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-external-check-fresh-'),
  );
  const externalCounter = path.join(countersRoot, 'external.log');
  const snapshot = bareDigest('external-snapshot-v1');
  try {
    installExternalCountingChecks(repository, {
      'external-check': externalCounter,
    });
    installExternalTrustedPolicy(repository, {
      'external-check': 10 * 60 * 1_000,
    });
    git(repository, ['checkout', '-b', 'work/demo-change']);

    const session = startSession(repository, 'demo-change', '1.1');
    fs.writeFileSync(
      path.join(repository, 'src/feature.ts'),
      'export const feature = true;\n',
    );
    weakenCandidateExternalFreshness(repository, 'external-check', 1);
    assert.throws(
      () => checkSession(repository, session.sessionId, { now: () => NOW }),
      (error) =>
        isWorkflowError(error, 'SESSION_EXTERNAL_STATE_SNAPSHOT_REQUIRED'),
    );
    assert.equal(lineCount(externalCounter), 0);
    const original = checkSession(repository, session.sessionId, {
      now: () => NOW,
      externalSnapshotDigests: { 'external-check': snapshot },
    });
    assert.equal(lineCount(externalCounter), 1);
    assert.equal(original.checks[0]!.completedAt, NOW.toISOString());
    assert.equal(original.checks[0]!.externalSnapshotDigest, snapshot);
    assert.equal(original.checks[0]!.maxAgeMs, 10 * 60 * 1_000);

    const adoption = adoptLocalEngine(repository, session.sessionId);
    const reconciled = withResumeBinding(adoption.resumeBinding, () =>
      checkSession(repository, session.sessionId, {
        now: () => new Date(NOW.getTime() + 2 * 60 * 1_000),
        externalSnapshotDigests: { 'external-check': snapshot },
      }),
    );
    assert.deepEqual(reconciled.executedCheckIds, []);
    assert.deepEqual(reconciled.reusedCheckIds, ['external-check']);
    assert.equal(lineCount(externalCounter), 1);
    assert.deepEqual(reconciled.checks, original.checks);
  } finally {
    fs.rmSync(interventionWorkspacePath(repository), {
      recursive: true,
      force: true,
    });
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(countersRoot, { recursive: true, force: true });
  }
});

test('local engine adoption reruns stale and snapshot-changed external-state evidence', () => {
  const repository = fs.realpathSync(createFixtureRepository());
  const countersRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-external-check-stale-'),
  );
  const changedCounter = path.join(countersRoot, 'changed.log');
  const staleCounter = path.join(countersRoot, 'stale.log');
  const snapshotV1 = bareDigest('external-snapshot-v1');
  const snapshotV2 = bareDigest('external-snapshot-v2');
  try {
    installExternalCountingChecks(repository, {
      'changed-check': changedCounter,
      'stale-check': staleCounter,
    });
    installExternalTrustedPolicy(repository, {
      'changed-check': 10 * 60 * 1_000,
      'stale-check': 60 * 1_000,
    });
    git(repository, ['checkout', '-b', 'work/demo-change']);

    const session = startSession(repository, 'demo-change', '1.1');
    fs.writeFileSync(
      path.join(repository, 'src/feature.ts'),
      'export const feature = true;\n',
    );
    weakenCandidateExternalFreshness(
      repository,
      'stale-check',
      24 * 60 * 60 * 1_000,
    );
    checkSession(repository, session.sessionId, {
      now: () => NOW,
      externalSnapshotDigests: {
        'changed-check': snapshotV1,
        'stale-check': snapshotV1,
      },
    });
    assert.deepEqual(
      [lineCount(changedCounter), lineCount(staleCounter)],
      [1, 1],
    );

    const adoption = adoptLocalEngine(repository, session.sessionId);
    const reconciledAt = new Date(NOW.getTime() + 2 * 60 * 1_000);
    const reconciled = withResumeBinding(adoption.resumeBinding, () =>
      checkSession(repository, session.sessionId, {
        now: () => reconciledAt,
        externalSnapshotDigests: {
          'changed-check': snapshotV2,
          'stale-check': snapshotV1,
        },
      }),
    );
    assert.deepEqual(reconciled.executedCheckIds, [
      'changed-check',
      'stale-check',
    ]);
    assert.deepEqual(reconciled.reusedCheckIds, []);
    assert.deepEqual(
      [lineCount(changedCounter), lineCount(staleCounter)],
      [2, 2],
    );
    assert.deepEqual(
      reconciled.checks.map((evidence) => ({
        checkId: evidence.checkId,
        completedAt: evidence.completedAt,
        externalSnapshotDigest: evidence.externalSnapshotDigest,
        maxAgeMs: evidence.maxAgeMs,
      })),
      [
        {
          checkId: 'changed-check',
          completedAt: reconciledAt.toISOString(),
          externalSnapshotDigest: snapshotV2,
          maxAgeMs: 10 * 60 * 1_000,
        },
        {
          checkId: 'stale-check',
          completedAt: reconciledAt.toISOString(),
          externalSnapshotDigest: snapshotV1,
          maxAgeMs: 60 * 1_000,
        },
      ],
    );
  } finally {
    fs.rmSync(interventionWorkspacePath(repository), {
      recursive: true,
      force: true,
    });
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(countersRoot, { recursive: true, force: true });
  }
});

function installCountingChecks(
  repository: string,
  sourceCounter: string,
  engineCounter: string,
): void {
  const counterScript = path.join(repository, 'scripts/count-check.mjs');
  fs.writeFileSync(
    counterScript,
    [
      "import fs from 'node:fs';",
      'fs.appendFileSync(process.argv[2], "passed\\n");',
      '',
    ].join('\n'),
  );
  configureChecks(
    repository,
    {
      'engine-check': {
        command: ['node', 'scripts/count-check.mjs', engineCounter],
        destructiveDatabase: false,
      },
      'source-check': {
        command: ['node', 'scripts/count-check.mjs', sourceCounter],
        destructiveDatabase: false,
      },
    },
    ['engine-check', 'source-check'],
  );
}

function installExternalCountingChecks(
  repository: string,
  counters: Record<string, string>,
): void {
  const counterScript = path.join(repository, 'scripts/count-check.mjs');
  fs.writeFileSync(
    counterScript,
    [
      "import fs from 'node:fs';",
      'fs.appendFileSync(process.argv[2], "passed\\n");',
      '',
    ].join('\n'),
  );
  const checkIds = Object.keys(counters).sort();
  configureChecks(
    repository,
    Object.fromEntries(
      checkIds.map((checkId) => [
        checkId,
        {
          command: ['node', 'scripts/count-check.mjs', counters[checkId]!],
          destructiveDatabase: false,
        },
      ]),
    ),
    checkIds,
  );
}

function installTrustedCheckDependencies(repository: string): void {
  const profilesPath = path.join(
    repository,
    'workflow/maintainer-profiles.json',
  );
  writeJson(profilesPath, {
    schemaVersion: 1,
    profiles: {
      'selective-check-fixture': {
        id: 'selective-check-fixture',
        version: 1,
        authorityClass: 'ordinary',
        implementationPaths: ['src/**'],
        evidencePaths: [],
        policyPaths: ['workflow/**'],
        verificationInfrastructurePaths: ['scripts/**'],
        forbiddenPaths: [],
        constraints: {
          evidenceOnlyGrantForbidden: true,
          samePackageRequired: true,
          evidenceAdditionsAllowed: true,
          maximumFiles: 10,
        },
        requiredChecks: ['engine-check', 'source-check'],
        checkDependencies: {
          'engine-check': ['harness-engine', 'runner', 'source-tree'],
          'source-check': ['runner', 'source-tree'],
        },
      },
    },
  });
  const guardPath = path.join(
    repository,
    'openspec/changes/demo-change/guard.json',
  );
  const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8')) as {
    tasks: Record<string, { allowedPaths: string[] }>;
  };
  guard.tasks['1.1']!.allowedPaths = [
    'src/**',
    'workflow/maintainer-profiles.json',
  ];
  writeJson(guardPath, guard);
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'Declare trusted check dependencies']);
}

function installExternalTrustedPolicy(
  repository: string,
  maxAgeByCheck: Record<string, number>,
): void {
  const checkIds = Object.keys(maxAgeByCheck).sort();
  const profilesPath = path.join(
    repository,
    'workflow/maintainer-profiles.json',
  );
  writeJson(profilesPath, {
    schemaVersion: 1,
    profiles: {
      'external-check-fixture': {
        id: 'external-check-fixture',
        version: 1,
        authorityClass: 'ordinary',
        implementationPaths: ['src/**'],
        evidencePaths: [],
        policyPaths: ['workflow/**'],
        verificationInfrastructurePaths: ['scripts/**'],
        forbiddenPaths: [],
        constraints: {
          evidenceOnlyGrantForbidden: true,
          samePackageRequired: true,
          evidenceAdditionsAllowed: true,
          maximumFiles: 10,
        },
        requiredChecks: checkIds,
        checkDependencies: Object.fromEntries(
          checkIds.map((checkId) => [checkId, ['external-state', 'runner']]),
        ),
        externalStateFreshness: Object.fromEntries(
          checkIds.map((checkId) => [
            checkId,
            { maxAgeMs: maxAgeByCheck[checkId] },
          ]),
        ),
      },
    },
  });
  const guardPath = path.join(
    repository,
    'openspec/changes/demo-change/guard.json',
  );
  const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8')) as {
    tasks: Record<string, { allowedPaths: string[] }>;
  };
  guard.tasks['1.1']!.allowedPaths = [
    'src/**',
    'workflow/maintainer-profiles.json',
  ];
  writeJson(guardPath, guard);
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'Declare external check freshness']);
}

function weakenCandidateExternalFreshness(
  repository: string,
  checkId: string,
  maxAgeMs: number,
): void {
  const profilesPath = path.join(
    repository,
    'workflow/maintainer-profiles.json',
  );
  const value = JSON.parse(fs.readFileSync(profilesPath, 'utf8')) as {
    profiles: Record<
      string,
      { externalStateFreshness: Record<string, { maxAgeMs: number }> }
    >;
  };
  value.profiles['external-check-fixture']!.externalStateFreshness[
    checkId
  ]!.maxAgeMs = maxAgeMs;
  writeJson(profilesPath, value);
}

function weakenCandidateDependencyDeclaration(repository: string): void {
  const profilesPath = path.join(
    repository,
    'workflow/maintainer-profiles.json',
  );
  const value = JSON.parse(fs.readFileSync(profilesPath, 'utf8')) as {
    profiles: Record<string, { checkDependencies: Record<string, string[]> }>;
  };
  value.profiles['selective-check-fixture']!.checkDependencies['engine-check'] =
    ['runner', 'source-tree'];
  writeJson(profilesPath, value);
}

function adoptLocalEngine(repository: string, sessionId: string) {
  const stateRoot = path.join(runtimeRoot(repository), 'intervention-control');
  const durable = resolveHarnessBootstrapParentState(
    repository,
    'demo-change',
    stateRoot,
  );
  const childWorkspace = interventionWorkspacePath(repository);
  const captured = capturePersistedWipIntervention(stateRoot, {
    repositoryRoot: repository,
    parent: durable.parent,
    interventionChangeId: 'intervention-B',
    childWorkspacePath: childWorkspace,
    changeRef: 'refs/heads/work/intervention-B',
    untrackedAllowlist: ['src/feature.ts'],
    sessionSnapshotPath: durable.sessionSnapshotPath,
    pendingIntent: durable.pendingIntent,
    policyDigest: durable.policyDigest,
    now: NOW,
  });
  const source = adoptedEngineSource(durable.parent.sessionSchema);
  fs.mkdirSync(childWorkspace, { mode: 0o700 });
  const executablePath = path.join(childWorkspace, 'engine-E2.mjs');
  fs.writeFileSync(executablePath, source, { mode: 0o755 });
  const artifact = createEngineArtifact({
    sourceChangeId: 'intervention-B',
    sourceDigest: digest('engine-source-E2'),
    executableDigest: digest(source),
    protocolVersion: 1,
    canReadSessionSchemas: [durable.parent.sessionSchema],
    writesSessionSchema: durable.parent.sessionSchema,
    policySchemaVersion: 1,
    smokeReportDigest: digest('engine-smoke-E2'),
  });
  persistInterventionEngineArtifact(stateRoot, {
    parentChangeId: 'demo-change',
    artifact,
    executablePath,
    now: NOW,
  });
  const txId = `selective-invalidation-${sessionId.replace(/[^a-z0-9-]/gi, '-')}`;
  const envelope = {
    payload: {
      kind: 'harness-maintenance-grant.v1' as const,
      grantId: 'selective-invalidation-grant',
      parentChangeId: 'demo-change',
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
      engineFromDigest: durable.parent.engineBinding,
      sessionSchema: durable.parent.sessionSchema,
      maxLocalAdoptions: 1,
      issuedAt: '2026-08-04T00:55:00.000Z',
      expiresAt: '2026-08-04T02:00:00.000Z',
      humanSigner: 'maintainer@example.test',
      reason: 'Exercise selective check invalidation.',
    },
    signature: 'selective-invalidation-human-signature',
  };
  const human = {
    now: () => NOW,
    verifyHumanSignature(
      _payload: string,
      signature: string,
      _signer: string,
      namespace: string,
    ) {
      return (
        signature === 'selective-invalidation-human-signature' &&
        namespace === 'expense-app.harness-maintenance-grant.v1'
      );
    },
  };
  const prepared = preparePersistedEngineAdoption(
    stateRoot,
    {
      txId,
      parentChangeId: 'demo-change',
      artifact,
      maintenanceGrantEnvelope: envelope,
      priorLocalAdoptions: 0,
    },
    human,
  );
  const bindingPath = parentBindingPath(stateRoot, 'demo-change');
  initializeLocalEngineBinding(stateRoot, bindingPath, {
    parentChangeId: 'demo-change',
    parentWorkspacePath: repository,
    parentBranch: 'refs/heads/work/demo-change',
    interventionChangeId: 'intervention-B',
    txId,
    checkpointId: captured.intervention.checkpoint.checkpointId,
    engineDigest: durable.parent.engineBinding,
    artifactId: artifact.artifactId,
    executableDigest: artifact.executableDigest,
    executablePath: localEngineArtifactPath(stateRoot, artifact.artifactId),
    sessionSchema: durable.parent.sessionSchema,
    now: NOW,
  });
  let journalDigest = prepared.journal.journalDigest;
  for (let index = 0; index < 5; index += 1) {
    const at = new Date(NOW.getTime() + (index + 1) * 1_000).toISOString();
    const stepped = executePersistedAdoptionStep(
      stateRoot,
      {
        txId,
        expectedJournalDigest: journalDigest,
        bindingPath,
        artifact,
        executablePath,
        at,
      },
      { ...human, now: () => new Date(at) },
    );
    journalDigest = stepped.record.journal.journalDigest;
  }
  return {
    txId,
    fromEngineDigest: durable.parent.engineBinding,
    resumeBinding: {
      kind: 'local-engine-resume-binding.v1' as const,
      parentChangeId: 'demo-change',
      checkpointId: captured.intervention.checkpoint.checkpointId,
      engineDigest: artifact.executableDigest,
    },
  };
}

function adoptedEngineSource(sessionSchema: string): string {
  return `#!/usr/bin/env node
const mode = process.argv[2];
if (mode === '--bootstrap-probe') {
  process.stdout.write(JSON.stringify({kind:'engine-bootstrap-probe.v1',started:true,sessionSchema:'${sessionSchema}'}) + '\\n');
  process.exit(0);
}
if (mode === '--health-check') {
  process.stdout.write(JSON.stringify({kind:'engine-health.v1',healthy:true,sessionSchema:'${sessionSchema}'}) + '\\n');
  process.exit(0);
}
process.exit(0);
`;
}

function withResumeBinding<T>(binding: unknown, operation: () => T): T {
  const previous = process.env.WORKFLOW_LOCAL_ENGINE_RESUME_BINDING;
  process.env.WORKFLOW_LOCAL_ENGINE_RESUME_BINDING = JSON.stringify(binding);
  try {
    return operation();
  } finally {
    if (previous === undefined) {
      delete process.env.WORKFLOW_LOCAL_ENGINE_RESUME_BINDING;
    } else {
      process.env.WORKFLOW_LOCAL_ENGINE_RESUME_BINDING = previous;
    }
  }
}

function parentBindingPath(stateRoot: string, parentChangeId: string): string {
  const identity = crypto
    .createHash('sha256')
    .update(`parent-session\0${parentChangeId}`)
    .digest('hex');
  return path.join(stateRoot, 'local-parent-sessions', `${identity}.json`);
}

function interventionWorkspacePath(repository: string): string {
  return path.join(
    path.dirname(repository),
    `${path.basename(repository)}.intervention-B`,
  );
}

function readCounts(sourceCounter: string, engineCounter: string) {
  return {
    source: lineCount(sourceCounter),
    engine: lineCount(engineCounter),
  };
}

function lineCount(filePath: string): number {
  return fs.existsSync(filePath)
    ? fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean)
        .length
    : 0;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function digest(value: string | Buffer): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function bareDigest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
