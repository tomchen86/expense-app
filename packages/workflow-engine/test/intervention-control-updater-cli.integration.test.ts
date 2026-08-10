import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/canonical-json.ts';
import { ExitCode, WorkflowError, workflowError } from '../src/errors.ts';
import {
  canonicalControlPlaneGrantPayload,
  controlPlaneCandidateDigest,
  controlPlaneIndependentReviewAttestationDigest,
  createEngineArtifact,
  createProtectedCapabilityManifest,
  protectedCapabilityClosureDigest,
  REQUIRED_PROTECTED_CAPABILITIES,
  type ControlPlaneGrantEnvelope,
  type ControlPlaneIndependentReviewAttestationEnvelope,
  type ExactControlPlaneChange,
  type ProtectedCapabilityEntry,
} from '../src/intervention-control.ts';
import {
  createControlPlanePromotionBundle,
  createControlPlaneRecoveryBundle,
  controlPlaneApprovalCandidatePath,
  initializeControlPlaneSupervisorState,
  persistControlPlaneApprovalCandidate,
  readControlPlaneSupervisorState,
  type ControlPlaneApprovalSummary,
  type ControlPlaneUpdaterAuditRecord,
} from '../src/intervention-control-updater.ts';
import {
  controlPlaneUpdaterUsage,
  dispatchControlPlaneUpdaterCommand,
} from '../src/intervention-control-updater-cli.ts';

const NOW = new Date('2026-08-03T10:00:00.000Z');

function digest(value: string | Buffer): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function git(repositoryRoot: string, args: string[]): string {
  return execFileSync('git', ['-C', repositoryRoot, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function entries(): ProtectedCapabilityEntry[] {
  return REQUIRED_PROTECTED_CAPABILITIES.map((capability) => {
    const entrypoints =
      capability === 'control-plane.update'
        ? ['packages/workflow-engine/engine.mjs']
        : [`packages/bootstrap/${capability}.ts`];
    const dependencies = [`packages/bootstrap/shared/${capability}.ts`];
    const contentDigest = digest(`content:${capability}`);
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
}

function engine(closureDigest: string, healthy = true): string {
  return `#!/usr/bin/env node
const mode = process.argv[2];
const response = mode === '--control-plane-self-test'
  ? {kind:'control-plane-self-test.v1',healthy:${healthy ? 'true' : 'false'},closureDigest:'${closureDigest}'}
  : {kind:'control-plane-restart.v1',ready:true,closureDigest:'${closureDigest}'};
process.stdout.write(JSON.stringify(response) + '\\n');
`;
}

function setup(
  options: {
    candidateHealthy?: boolean;
    reviewCandidateDigest?: `sha256:${string}`;
    reviewSignature?: string;
  } = {},
) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'control-plane-cli-')),
  );
  fs.chmodSync(root, 0o700);
  const repositoryRoot = path.join(root, 'repository');
  fs.mkdirSync(repositoryRoot, { mode: 0o700 });
  git(repositoryRoot, ['init', '-b', 'main']);
  git(repositoryRoot, ['config', 'user.email', 'workflow@example.test']);
  git(repositoryRoot, ['config', 'user.name', 'Workflow Test']);
  fs.writeFileSync(path.join(repositoryRoot, 'README.md'), 'fixture\n');
  git(repositoryRoot, ['add', 'README.md']);
  git(repositoryRoot, ['commit', '-m', 'Create updater fixture']);
  const gitCommonValue = git(repositoryRoot, [
    'rev-parse',
    '--git-common-dir',
  ]).trim();
  const gitCommonDirectory = fs.realpathSync(
    path.isAbsolute(gitCommonValue)
      ? gitCommonValue
      : path.resolve(repositoryRoot, gitCommonValue),
  );
  const storageRoot = path.join(
    gitCommonDirectory,
    'workflow-engine',
    'intervention-control',
  );
  fs.mkdirSync(storageRoot, { recursive: true, mode: 0o700 });
  const mandateBinding = {
    schemaVersion: 1 as const,
    parentTaskId: 'control-plane-task',
    mandateId: '11111111-1111-4111-8111-111111111111',
    mandateDigest: '1'.repeat(64),
    changeId: 'control-plane-change',
    externalAuditRoot: path.join(root, 'external-audit'),
  };
  const beforeManifest = createProtectedCapabilityManifest({
    schemaVersion: 1,
    manifestPath: 'workflow/protected-capabilities.json',
    entries: entries(),
  });
  const afterEntries = entries();
  const index = afterEntries.findIndex(
    ({ capability }) => capability === 'control-plane.update',
  );
  const contentDigest = digest('new-control-plane');
  afterEntries[index] = {
    ...afterEntries[index],
    contentDigest,
    closureDigest: protectedCapabilityClosureDigest(
      afterEntries[index].entrypoints,
      afterEntries[index].dependencies,
      contentDigest,
    ),
  };
  const afterManifest = createProtectedCapabilityManifest({
    schemaVersion: 1,
    manifestPath: beforeManifest.manifestPath,
    entries: afterEntries,
  });
  const oldSource = engine(beforeManifest.manifestDigest);
  const candidateSource = engine(
    afterManifest.manifestDigest,
    options.candidateHealthy ?? true,
  );
  const executablePath = 'packages/workflow-engine/engine.mjs';
  const beforeManifestBytes = Buffer.from(
    canonicalJson(
      Object.fromEntries(
        Object.entries(beforeManifest).filter(
          ([key]) => key !== 'manifestDigest',
        ),
      ),
    ),
  );
  const afterManifestBytes = Buffer.from(
    canonicalJson(
      Object.fromEntries(
        Object.entries(afterManifest).filter(
          ([key]) => key !== 'manifestDigest',
        ),
      ),
    ),
  );
  const changes: ExactControlPlaneChange[] = [
    {
      path: executablePath,
      beforeDigest: digest(oldSource),
      afterDigest: digest(candidateSource),
    },
    {
      path: beforeManifest.manifestPath,
      beforeDigest: beforeManifest.manifestDigest,
      afterDigest: afterManifest.manifestDigest,
    },
  ].sort((left, right) => left.path.localeCompare(right.path));
  const oldArtifact = createEngineArtifact({
    sourceChangeId: 'cli-E1',
    sourceDigest: digest('cli-source-E1'),
    executableDigest: digest(oldSource),
    protocolVersion: 1,
    canReadSessionSchemas: ['v1'],
    writesSessionSchema: 'v1',
    policySchemaVersion: 1,
    smokeReportDigest: digest('cli-smoke-E1'),
  });
  const candidateArtifact = createEngineArtifact({
    sourceChangeId: 'cli-E2',
    sourceDigest: digest('cli-source-E2'),
    executableDigest: digest(candidateSource),
    protocolVersion: 1,
    canReadSessionSchemas: ['v1'],
    writesSessionSchema: 'v1',
    policySchemaVersion: 1,
    smokeReportDigest: digest('cli-smoke-E2'),
  });
  const rollbackReport = Buffer.from('rollback tested');
  const recoveryBundle = createControlPlaneRecoveryBundle({
    repositoryId: 'github:example/expense-app',
    previousClosureDigest: beforeManifest.manifestDigest,
    restartArtifact: oldArtifact,
    restartExecutablePath: executablePath,
    previousFiles: [
      {
        path: executablePath,
        mode: '100755' as const,
        contentBase64: Buffer.from(oldSource).toString('base64'),
        contentDigest: digest(oldSource),
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
  const independentReviewAttestation: ControlPlaneIndependentReviewAttestationEnvelope =
    {
      payload: {
        kind: 'control-plane-independent-review.v1',
        repositoryId: recoveryBundle.repositoryId,
        candidateDigest:
          options.reviewCandidateDigest ?? controlPlaneCandidateDigest(changes),
        beforeClosureDigest: beforeManifest.manifestDigest,
        afterClosureDigest: afterManifest.manifestDigest,
        recoveryBundleDigest: recoveryBundle.bundleDigest,
        affectedCapabilities: ['control-plane.update'],
        verdict: 'approved',
        reviewedAt: '2026-08-03T09:50:00.000Z',
        reviewSummary: 'Reviewed the exact CLI promotion and recovery bytes.',
        reviewer: 'cli-reviewer@example.test',
      },
      signature: options.reviewSignature ?? 'cli-review-signature',
    };
  const bundle = createControlPlanePromotionBundle({
    mandateBinding,
    repositoryId: recoveryBundle.repositoryId,
    candidateDigest: controlPlaneCandidateDigest(changes),
    beforeClosureDigest: beforeManifest.manifestDigest,
    afterClosureDigest: afterManifest.manifestDigest,
    exactChanges: changes,
    candidateArtifact,
    candidateExecutablePath: executablePath,
    candidateFiles: [
      {
        path: executablePath,
        mode: '100755' as const,
        contentBase64: Buffer.from(candidateSource).toString('base64'),
        contentDigest: digest(candidateSource),
      },
      {
        path: beforeManifest.manifestPath,
        mode: '100644' as const,
        contentBase64: afterManifestBytes.toString('base64'),
        contentDigest: afterManifest.manifestDigest,
      },
    ].sort((left, right) => left.path.localeCompare(right.path)),
    recoveryBundle,
    independentReviewAttestation,
  });
  const envelope: ControlPlaneGrantEnvelope = {
    payload: {
      kind: 'control-plane-grant.v1',
      grantId: 'cli-control-plane-grant',
      mandateBinding,
      repositoryId: bundle.repositoryId,
      candidateDigest: bundle.candidateDigest,
      exactChanges: changes,
      beforeClosureDigest: bundle.beforeClosureDigest,
      afterClosureDigest: bundle.afterClosureDigest,
      affectedCapabilities: ['control-plane.update'],
      behaviorChangeSummary:
        'Promote exact E2 through the minimal updater CLI.',
      recoveryBundle: {
        bundleDigest: recoveryBundle.bundleDigest,
        previousClosureDigest: recoveryBundle.previousClosureDigest,
        restartArtifactDigest: oldArtifact.executableDigest,
        rollbackTestReportDigest: recoveryBundle.rollbackTestReportDigest,
      },
      independentReviewAttestationDigest:
        controlPlaneIndependentReviewAttestationDigest(
          independentReviewAttestation,
        ),
      updaterVersion: 1,
      oneShot: true,
      issuedAt: '2026-08-03T09:55:00.000Z',
      expiresAt: '2026-08-03T11:00:00.000Z',
      humanSigner: 'maintainer@example.test',
    },
    signature: 'cli-signature',
  };
  initializeControlPlaneSupervisorState(storageRoot, {
    repositoryId: envelope.payload.repositoryId,
    closureDigest: beforeManifest.manifestDigest,
    artifact: oldArtifact,
    executableBase64: Buffer.from(oldSource).toString('base64'),
    now: NOW,
  });
  const requestPath = path.join(root, 'promotion.json');
  fs.writeFileSync(
    requestPath,
    `${canonicalJson({
      kind: 'control-plane-promotion-request.v1',
      txId: 'cli-promotion-1',
      envelope,
      beforeManifest,
      afterManifest,
      bundle,
    })}\n`,
    { mode: 0o600 },
  );
  return {
    root,
    repositoryRoot,
    storageRoot,
    mandateBinding,
    requestPath,
    envelope,
    beforeManifest,
    afterManifest,
    bundle,
    oldArtifact,
    candidateArtifact,
  };
}

type SetupValue = ReturnType<typeof setup>;

function approvalArgv(value: SetupValue, candidateId: string): string[] {
  return [
    'approve-and-apply',
    candidateId,
    '--task',
    value.mandateBinding.parentTaskId,
  ];
}

function stageApprovalCandidate(value: SetupValue) {
  return persistControlPlaneApprovalCandidate(
    value.storageRoot,
    {
      txId: 'cli-promotion-1',
      mandateBinding: value.mandateBinding,
      beforeManifest: value.beforeManifest,
      afterManifest: value.afterManifest,
      bundle: value.bundle,
    },
    NOW,
  );
}

function approvalDependencies(
  value: SetupValue,
  options: {
    tty?: boolean;
    signer?: string;
    grantSignature?: string;
    afterAtomicSwitch?: () => void;
    resolveMandate?: () => SetupValue['mandateBinding'];
    revalidateMandate?: (
      binding: SetupValue['mandateBinding'],
      phase: string,
      call: number,
    ) => void;
  } = {},
) {
  const audit: ControlPlaneUpdaterAuditRecord[] = [];
  const summaries: ControlPlaneApprovalSummary[] = [];
  const signedPayloads: string[] = [];
  const signerCalls = { present: 0, identity: 0, sign: 0 };
  const mandateCalls = { resolve: 0, revalidate: 0 };
  const mandatePhases: string[] = [];
  const signerIdentity = options.signer ?? 'maintainer@example.test';
  const grantSignature =
    options.grantSignature ?? 'cli-control-plane-human-signature';
  return {
    audit,
    summaries,
    signedPayloads,
    signerCalls,
    mandateCalls,
    mandatePhases,
    dependencies: {
      now: () => NOW,
      consumedGrantIds: new Set<string>(),
      verifyHumanSignature(
        _payload: string,
        signature: string,
        signer: string,
        namespace: string,
      ) {
        return (
          (signature === 'cli-control-plane-human-signature' &&
            signer === 'maintainer@example.test' &&
            namespace === 'expense-app.control-plane-grant.v1') ||
          (signature === 'cli-review-signature' &&
            signer === 'cli-reviewer@example.test' &&
            namespace === 'expense-app.control-plane-independent-review.v1')
        );
      },
      auditSink: {
        append(record: ControlPlaneUpdaterAuditRecord) {
          const existing = audit.find(
            ({ recordId }) => recordId === record.recordId,
          );
          if (existing) assert.deepEqual(existing, record);
          else audit.push(record);
        },
      },
      resolveTaskMandateBinding(parentTaskId: string) {
        mandateCalls.resolve += 1;
        assert.equal(parentTaskId, value.mandateBinding.parentTaskId);
        return structuredClone(
          options.resolveMandate?.() ?? value.mandateBinding,
        );
      },
      revalidateTaskMandateBinding(
        binding: SetupValue['mandateBinding'],
        phase: string,
      ) {
        mandateCalls.revalidate += 1;
        mandatePhases.push(phase);
        options.revalidateMandate?.(binding, phase, mandateCalls.revalidate);
      },
      ...(options.afterAtomicSwitch
        ? { testHooks: { afterAtomicSwitch: options.afterAtomicSwitch } }
        : {}),
      approvalSigner: {
        assertHumanPresent() {
          signerCalls.present += 1;
          if (options.tty === false) {
            throw workflowError(
              'CONTROL_PLANE_APPROVAL_TTY_REQUIRED',
              'Control-plane approval requires a controlling terminal.',
              ExitCode.unsafeEnvironment,
            );
          }
        },
        identity() {
          signerCalls.identity += 1;
          return signerIdentity;
        },
        sign(payload: string, namespace?: string) {
          signerCalls.sign += 1;
          assert.equal(namespace, 'expense-app.control-plane-grant.v1');
          signedPayloads.push(payload);
          return grantSignature;
        },
        verify() {},
      },
      presentApprovalSummary(summary: ControlPlaneApprovalSummary) {
        summaries.push(summary);
      },
    },
  };
}

function snapshotTree(root: string): string {
  const entries: string[] = [];
  function visit(directory: string): void {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute);
      const stats = fs.lstatSync(absolute);
      if (entry.isDirectory()) {
        entries.push(`d ${relative} ${(stats.mode & 0o777).toString(8)}`);
        visit(absolute);
      } else {
        entries.push(
          `f ${relative} ${(stats.mode & 0o777).toString(8)} ${digest(
            fs.readFileSync(absolute),
          )}`,
        );
      }
    }
  }
  visit(root);
  return entries.join('\n');
}

test('control-plane dispatcher argv binds approval to task and recovery to durable state', () => {
  assert.equal(
    controlPlaneUpdaterUsage(),
    [
      'Usage: pnpm workflow control-plane <command> [--json]',
      '  control-plane approve-and-apply <candidate-id> --task <parent-task-id>',
      '  control-plane recover <grant-id>',
      '  control-plane status <grant-id>',
    ].join('\n'),
  );
  assert.equal(controlPlaneUpdaterUsage().includes('--audit-root'), false);
});

test('approve-and-apply derives the summary, signs exact bytes, promotes, and reports status', () => {
  const value = setup();
  const candidate = stageApprovalCandidate(value);
  const approval = approvalDependencies(value);
  try {
    const promoted = dispatchControlPlaneUpdaterCommand(
      approvalArgv(value, candidate.candidateId),
      value.storageRoot,
      approval.dependencies,
    );
    assert.equal(promoted.action, 'approve-and-apply');
    assert.equal(promoted.record?.transaction.state, 'FINALIZED');
    assert.equal(
      promoted.supervisor.activeArtifact.artifactId,
      value.candidateArtifact.artifactId,
    );
    assert.equal(approval.signerCalls.present, 1);
    assert.equal(approval.signerCalls.identity, 1);
    assert.equal(approval.signerCalls.sign, 1);
    assert.equal(approval.mandateCalls.resolve, 1);
    assert.equal(approval.mandateCalls.revalidate > 1, true);
    assert.equal(approval.mandatePhases[0], 'approval-preflight');
    assert.equal(approval.mandatePhases.includes('before-atomic-switch'), true);
    assert.deepEqual(promoted.record?.envelope.payload.mandateBinding, {
      ...value.mandateBinding,
    });
    assert.deepEqual(candidate.mandateBinding, value.mandateBinding);
    assert.deepEqual(candidate.bundle.mandateBinding, value.mandateBinding);
    assert.deepEqual(approval.signedPayloads, [
      canonicalControlPlaneGrantPayload(promoted.record!.envelope.payload),
    ]);
    assert.equal(approval.summaries.length, 1);
    assert.equal(approval.summaries[0]?.candidateId, candidate.candidateId);
    assert.deepEqual(
      approval.summaries[0]?.mandateBinding,
      value.mandateBinding,
    );
    assert.deepEqual(approval.summaries[0]?.affectedCapabilities, [
      'control-plane.update',
    ]);
    assert.match(
      approval.summaries[0]?.humanReadable ?? '',
      /Reviewed the exact CLI promotion and recovery bytes\./,
    );
    assert.match(
      approval.summaries[0]?.humanReadable ?? '',
      new RegExp(value.bundle.recoveryBundle.bundleDigest),
    );
    assert.match(
      approval.summaries[0]?.humanReadable ?? '',
      new RegExp(value.mandateBinding.parentTaskId),
    );
    assert.match(
      approval.summaries[0]?.humanReadable ?? '',
      new RegExp(value.mandateBinding.externalAuditRoot),
    );
    assert.equal(approval.audit.length > 0, true);
    for (const record of approval.audit) {
      assert.deepEqual(record.mandateBinding, value.mandateBinding);
      assert.equal(record.parentTaskId, value.mandateBinding.parentTaskId);
      assert.equal(record.changeId, value.mandateBinding.changeId);
      assert.equal(
        record.externalAuditRoot,
        value.mandateBinding.externalAuditRoot,
      );
    }
    const status = dispatchControlPlaneUpdaterCommand(
      ['status', promoted.grantId],
      value.storageRoot,
      approval.dependencies,
    );
    assert.equal(status.action, 'status');
    assert.equal(status.record?.grantState, 'consumed');
    const mainCliStatus = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--experimental-strip-types',
          path.resolve(import.meta.dirname, '../src/cli.ts'),
          'control-plane',
          'status',
          promoted.grantId,
          '--json',
        ],
        { cwd: value.repositoryRoot, encoding: 'utf8' },
      ),
    ) as {
      ok: boolean;
      result: { action: string; stateRoot: string };
    };
    assert.equal(mainCliStatus.ok, true);
    assert.equal(mainCliStatus.result.action, 'status');
    assert.equal(mainCliStatus.result.stateRoot, value.storageRoot);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('candidate persistence requires the exact parent Task Mandate binding', () => {
  const value = setup();
  try {
    const before = snapshotTree(value.storageRoot);
    assert.throws(
      () =>
        persistControlPlaneApprovalCandidate(
          value.storageRoot,
          {
            txId: 'cli-promotion-1',
            mandateBinding: {
              ...value.mandateBinding,
              changeId: 'another-change',
            },
            beforeManifest: value.beforeManifest,
            afterManifest: value.afterManifest,
            bundle: value.bundle,
          },
          NOW,
        ),
      (error: unknown) =>
        error instanceof WorkflowError &&
        error.code === 'CONTROL_PLANE_TASK_MANDATE_BINDING_MISMATCH',
    );
    assert.equal(snapshotTree(value.storageRoot), before);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('approval rejects cross-task, cross-root, revoked, and replaced mandates before switch', async (suite) => {
  await suite.test('cross-task argv', () => {
    const value = setup();
    try {
      const candidate = stageApprovalCandidate(value);
      const approval = approvalDependencies(value);
      assert.throws(
        () =>
          dispatchControlPlaneUpdaterCommand(
            [
              'approve-and-apply',
              candidate.candidateId,
              '--task',
              'another-task',
            ],
            value.storageRoot,
            approval.dependencies,
          ),
        (error: unknown) =>
          error instanceof WorkflowError &&
          error.code === 'CONTROL_PLANE_PARENT_TASK_MISMATCH',
      );
      assert.equal(approval.mandateCalls.resolve, 0);
      assert.equal(approval.signerCalls.present, 0);
    } finally {
      fs.rmSync(value.root, { recursive: true, force: true });
    }
  });

  for (const field of ['changeId', 'externalAuditRoot'] as const) {
    await suite.test(`cross-${field}`, () => {
      const value = setup();
      try {
        const candidate = stageApprovalCandidate(value);
        const approval = approvalDependencies(value, {
          resolveMandate: () => ({
            ...value.mandateBinding,
            [field]:
              field === 'changeId'
                ? 'another-change'
                : path.join(value.root, 'another-audit-root'),
          }),
        });
        assert.throws(
          () =>
            dispatchControlPlaneUpdaterCommand(
              approvalArgv(value, candidate.candidateId),
              value.storageRoot,
              approval.dependencies,
            ),
          (error: unknown) =>
            error instanceof WorkflowError &&
            error.code === 'CONTROL_PLANE_TASK_MANDATE_BINDING_MISMATCH',
        );
        assert.equal(approval.signerCalls.present, 0);
      } finally {
        fs.rmSync(value.root, { recursive: true, force: true });
      }
    });
  }

  await suite.test('revoked before approval', () => {
    const value = setup();
    try {
      const candidate = stageApprovalCandidate(value);
      const approval = approvalDependencies(value, {
        resolveMandate: () => {
          throw workflowError(
            'TASK_MANDATE_REVOKED',
            'Parent Task Mandate is revoked.',
            ExitCode.staleState,
          );
        },
      });
      assert.throws(
        () =>
          dispatchControlPlaneUpdaterCommand(
            approvalArgv(value, candidate.candidateId),
            value.storageRoot,
            approval.dependencies,
          ),
        (error: unknown) =>
          error instanceof WorkflowError &&
          error.code === 'TASK_MANDATE_REVOKED',
      );
      assert.equal(approval.signerCalls.present, 0);
    } finally {
      fs.rmSync(value.root, { recursive: true, force: true });
    }
  });

  await suite.test('replaced immediately before atomic switch', () => {
    const value = setup();
    try {
      const candidate = stageApprovalCandidate(value);
      const approval = approvalDependencies(value, {
        revalidateMandate(_binding, phase) {
          if (phase === 'before-atomic-switch') {
            throw workflowError(
              'TASK_MANDATE_BINDING_STALE',
              'Parent Task Mandate was replaced.',
              ExitCode.staleState,
            );
          }
        },
      });
      assert.throws(
        () =>
          dispatchControlPlaneUpdaterCommand(
            approvalArgv(value, candidate.candidateId),
            value.storageRoot,
            approval.dependencies,
          ),
        (error: unknown) =>
          error instanceof WorkflowError &&
          error.code === 'TASK_MANDATE_BINDING_STALE',
      );
      assert.equal(
        readControlPlaneSupervisorState(value.storageRoot).activeArtifact
          .artifactId,
        value.oldArtifact.artifactId,
      );
      assert.equal(approval.signerCalls.sign, 1);
      assert.equal(approval.summaries.length, 1);
      assert.equal(
        approval.mandatePhases.includes('before-atomic-switch'),
        true,
      );
    } finally {
      fs.rmSync(value.root, { recursive: true, force: true });
    }
  });
});

test('main CLI routes approve-and-apply through Task Mandate preflight', () => {
  const value = setup();
  const candidate = stageApprovalCandidate(value);
  try {
    const before = snapshotTree(value.storageRoot);
    const invoked = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        path.resolve(import.meta.dirname, '../src/cli.ts'),
        'control-plane',
        'approve-and-apply',
        candidate.candidateId,
        '--task',
        value.mandateBinding.parentTaskId,
        '--json',
      ],
      { cwd: value.repositoryRoot, encoding: 'utf8' },
    );
    assert.notEqual(invoked.status, 0);
    const failure = JSON.parse(invoked.stderr) as { error: { code: string } };
    assert.equal(failure.error.code, 'TASK_MANDATE_NOT_FOUND');
    assert.equal(snapshotTree(value.storageRoot), before);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('production updater rejects caller-supplied signed promotion request JSON without mutation', () => {
  const value = setup();
  const approval = approvalDependencies(value);
  try {
    const before = snapshotTree(value.storageRoot);
    assert.throws(
      () =>
        dispatchControlPlaneUpdaterCommand(
          ['promote', '--request', value.requestPath],
          value.storageRoot,
          approval.dependencies,
        ),
      (error: unknown) =>
        error instanceof WorkflowError &&
        error.code === 'CONTROL_PLANE_CALLER_SUPPLIED_REQUEST_DISABLED',
    );
    assert.throws(
      () =>
        dispatchControlPlaneUpdaterCommand(
          [
            'recover',
            value.envelope.payload.grantId,
            '--audit-root',
            value.mandateBinding.externalAuditRoot,
          ],
          value.storageRoot,
          approval.dependencies,
        ),
      (error: unknown) =>
        error instanceof WorkflowError &&
        error.code === 'CONTROL_PLANE_CALLER_AUDIT_ROOT_DISABLED',
    );
    assert.equal(snapshotTree(value.storageRoot), before);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('approval failures are read-only before the atomic switch', async (suite) => {
  await suite.test('missing controlling TTY', () => {
    const value = setup();
    try {
      const candidate = stageApprovalCandidate(value);
      const approval = approvalDependencies(value, { tty: false });
      const before = snapshotTree(value.storageRoot);
      assert.throws(
        () =>
          dispatchControlPlaneUpdaterCommand(
            approvalArgv(value, candidate.candidateId),
            value.storageRoot,
            approval.dependencies,
          ),
        (error: unknown) =>
          error instanceof WorkflowError &&
          error.code === 'CONTROL_PLANE_APPROVAL_TTY_REQUIRED',
      );
      assert.equal(snapshotTree(value.storageRoot), before);
      assert.equal(approval.signerCalls.sign, 0);
      assert.deepEqual(approval.summaries, []);
    } finally {
      fs.rmSync(value.root, { recursive: true, force: true });
    }
  });

  await suite.test('untrusted signer', () => {
    const value = setup();
    try {
      const candidate = stageApprovalCandidate(value);
      const approval = approvalDependencies(value, {
        signer: 'attacker@example.test',
      });
      const before = snapshotTree(value.storageRoot);
      assert.throws(
        () =>
          dispatchControlPlaneUpdaterCommand(
            approvalArgv(value, candidate.candidateId),
            value.storageRoot,
            approval.dependencies,
          ),
        (error: unknown) =>
          error instanceof WorkflowError &&
          error.code === 'CONTROL_PLANE_GRANT_SIGNATURE_INVALID',
      );
      assert.equal(snapshotTree(value.storageRoot), before);
    } finally {
      fs.rmSync(value.root, { recursive: true, force: true });
    }
  });

  await suite.test('candidate bytes drift', () => {
    const value = setup();
    try {
      const candidate = stageApprovalCandidate(value);
      const target = controlPlaneApprovalCandidatePath(
        value.storageRoot,
        candidate.candidateId,
      );
      fs.writeFileSync(
        target,
        fs
          .readFileSync(target, 'utf8')
          .replace('"txId":"cli-promotion-1"', '"txId":"drifted"'),
      );
      const approval = approvalDependencies(value);
      const before = snapshotTree(value.storageRoot);
      assert.throws(
        () =>
          dispatchControlPlaneUpdaterCommand(
            approvalArgv(value, candidate.candidateId),
            value.storageRoot,
            approval.dependencies,
          ),
        (error: unknown) =>
          error instanceof WorkflowError &&
          error.code === 'CONTROL_PLANE_APPROVAL_CANDIDATE_CORRUPT',
      );
      assert.equal(snapshotTree(value.storageRoot), before);
      assert.equal(approval.signerCalls.present, 0);
    } finally {
      fs.rmSync(value.root, { recursive: true, force: true });
    }
  });

  await suite.test('independent review mismatch', () => {
    const value = setup({ reviewCandidateDigest: digest('other-candidate') });
    try {
      const candidate = stageApprovalCandidate(value);
      const approval = approvalDependencies(value);
      const before = snapshotTree(value.storageRoot);
      assert.throws(
        () =>
          dispatchControlPlaneUpdaterCommand(
            approvalArgv(value, candidate.candidateId),
            value.storageRoot,
            approval.dependencies,
          ),
        (error: unknown) =>
          error instanceof WorkflowError &&
          error.code === 'CONTROL_PLANE_REVIEW_CANDIDATE_MISMATCH',
      );
      assert.equal(snapshotTree(value.storageRoot), before);
      assert.equal(approval.signerCalls.sign, 0);
    } finally {
      fs.rmSync(value.root, { recursive: true, force: true });
    }
  });

  await suite.test('control-plane grant signature failure', () => {
    const value = setup();
    try {
      const candidate = stageApprovalCandidate(value);
      const approval = approvalDependencies(value, {
        grantSignature: 'invalid-control-plane-signature',
      });
      const before = snapshotTree(value.storageRoot);
      assert.throws(
        () =>
          dispatchControlPlaneUpdaterCommand(
            approvalArgv(value, candidate.candidateId),
            value.storageRoot,
            approval.dependencies,
          ),
        (error: unknown) =>
          error instanceof WorkflowError &&
          error.code === 'CONTROL_PLANE_GRANT_SIGNATURE_INVALID',
      );
      assert.equal(snapshotTree(value.storageRoot), before);
    } finally {
      fs.rmSync(value.root, { recursive: true, force: true });
    }
  });
});

test('approve-and-apply rolls back an unhealthy candidate and consumes the one-shot grant', () => {
  const value = setup({ candidateHealthy: false });
  try {
    const candidate = stageApprovalCandidate(value);
    const approval = approvalDependencies(value);
    const result = dispatchControlPlaneUpdaterCommand(
      approvalArgv(value, candidate.candidateId),
      value.storageRoot,
      approval.dependencies,
    );
    assert.equal(result.record?.transaction.state, 'ROLLED_BACK');
    assert.equal(result.record?.grantState, 'consumed');
    assert.equal(
      result.supervisor.activeArtifact.artifactId,
      value.oldArtifact.artifactId,
    );
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('recover derives audit and task scope from durable signed state after a switch crash', () => {
  const value = setup();
  try {
    const candidate = stageApprovalCandidate(value);
    const crashing = approvalDependencies(value, {
      afterAtomicSwitch() {
        throw new Error('simulated control-plane switch crash');
      },
    });
    assert.throws(
      () =>
        dispatchControlPlaneUpdaterCommand(
          approvalArgv(value, candidate.candidateId),
          value.storageRoot,
          crashing.dependencies,
        ),
      /simulated control-plane switch crash/,
    );
    assert.equal(
      readControlPlaneSupervisorState(value.storageRoot).activeArtifact
        .artifactId,
      value.candidateArtifact.artifactId,
    );
    const recovering = approvalDependencies(value, {
      revalidateMandate() {
        throw workflowError(
          'TASK_MANDATE_REVOKED',
          'Mandate was revoked after the switch.',
          ExitCode.staleState,
        );
      },
    });
    const grantId = `control-plane-approval-${candidate.candidateId.slice(
      'sha256:'.length,
    )}`;
    const recovered = dispatchControlPlaneUpdaterCommand(
      ['recover', grantId],
      value.storageRoot,
      recovering.dependencies,
    );
    assert.equal(recovered.record?.transaction.state, 'ROLLED_BACK');
    assert.equal(
      recovered.supervisor.activeArtifact.artifactId,
      value.oldArtifact.artifactId,
    );
    assert.equal(recovering.mandateCalls.revalidate, 0);
    for (const record of recovering.audit) {
      assert.deepEqual(record.mandateBinding, value.mandateBinding);
      assert.equal(
        record.externalAuditRoot,
        value.mandateBinding.externalAuditRoot,
      );
    }
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('approve-and-apply replay is rejected without a second signature or mutation', () => {
  const value = setup();
  try {
    const candidate = stageApprovalCandidate(value);
    const approval = approvalDependencies(value);
    dispatchControlPlaneUpdaterCommand(
      approvalArgv(value, candidate.candidateId),
      value.storageRoot,
      approval.dependencies,
    );
    const before = snapshotTree(value.storageRoot);
    const signaturesBefore = approval.signerCalls.sign;
    assert.throws(
      () =>
        dispatchControlPlaneUpdaterCommand(
          approvalArgv(value, candidate.candidateId),
          value.storageRoot,
          approval.dependencies,
        ),
      (error: unknown) =>
        error instanceof WorkflowError &&
        error.code ===
          'INTERVENTION_CONTROL_GRANT_ALREADY_RESERVED_OR_CONSUMED',
    );
    assert.equal(snapshotTree(value.storageRoot), before);
    assert.equal(approval.signerCalls.sign, signaturesBefore);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});
