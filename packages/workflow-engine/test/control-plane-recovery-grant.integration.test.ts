import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveControlPlaneEngineSelection } from '../bootstrap/control-plane-trust.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { deriveAuthorityAuditRepositoryId } from '../src/runtime/storage-journal/authority-audit-ledger.ts';
import { verifyAuthorityAuditEvents } from '../src/runtime/storage-journal/authority-audit-service.ts';
import {
  HARNESS_RECOVERY_SIGNATURE_NAMESPACE,
  canonicalControlPlaneRecoveryGrantPayload,
  controlPlaneRecoveryPrestateDigest,
  createControlPlaneRecoveryGrantPayload,
  findPersistedControlPlaneRecoveryGrantForSource,
  readPersistedControlPlaneRecoveryGrant,
  reservePersistedControlPlaneRecoveryGrant,
  type ControlPlaneRecoveryAuditRecord,
  type ControlPlaneRecoveryGrantEnvelope,
} from '../src/modules/authority/control-plane-recovery-grant.ts';
import { runHarnessBootstrapCli } from '../src/harness-bootstrap.ts';
import {
  CONTROL_PLANE_REVIEW_SIGNATURE_NAMESPACE_V2,
  CONTROL_PLANE_SIGNATURE_NAMESPACE_V2,
  controlPlaneCandidateDigestV2,
  controlPlaneIndependentReviewAttestationDigestV2,
  controlPlanePromotionMaterialDigest,
  createControlPlanePromotionBundleV2,
  createControlPlanePromotionMaterial,
  createControlPlaneRecoveryBundleMaterial,
  createEngineArtifact,
  createProtectedCapabilityManifest,
  protectedCapabilityClosureDigest,
  REQUIRED_PROTECTED_CAPABILITIES,
  type ControlPlaneGrantEnvelopeV2,
  type ControlPlaneIndependentReviewAttestationEnvelopeV2,
  type ExactControlPlaneChangeV2,
  type ProtectedCapabilityEntry,
} from '../src/modules/authority/intervention-control.ts';
import { produceControlPlaneApprovalCandidateV2 } from '../src/application/control-plane/control-plane-promotion-producer.ts';
import { dispatchProductionControlPlaneUpdaterCommand } from '../src/entrypoints/cli/intervention-control-updater-cli.ts';
import {
  persistInterventionPlan,
  readPersistedControlPlaneUpdate,
} from '../src/runtime/storage-journal/intervention-control-persistence.ts';
import { persistInterventionEngineArtifact } from '../src/application/control-plane/intervention-maintenance.ts';
import {
  executeControlPlanePromotion,
  executeControlPlaneRecoveryRollback,
  initializeControlPlaneSupervisorState,
  preflightControlPlaneRecoveryRollback,
  prepareControlPlanePromotionV2,
  readControlPlaneSupervisorState,
  type ControlPlaneUpdaterAuditRecord,
  type ControlPlaneRecoveryExecutorDependencies,
} from '../src/application/control-plane/intervention-control-updater.ts';
import {
  CONTROL_PLANE_FIXTURE_GRANT_SIGNER,
  CONTROL_PLANE_FIXTURE_REVIEWER,
  controlPlaneFixtureUpdaterDependencies,
  setupControlPlaneProducerFixture,
} from './control-plane-promotion-fixture.ts';
import { createFixtureRepository } from './fixture.ts';

const NOW = new Date('2026-08-03T10:00:00.000Z');
const RECOVERY_NOW = new Date('2026-08-03T10:01:00.000Z');
const REPOSITORY_ID = 'github:fixture-expense-app';
const REPOSITORY_ORIGIN = 'https://github.com/example/expense-app.git';
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

function privateStateRoot(prefix: string): string {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), prefix)),
  );
  fs.chmodSync(directory, 0o700);
  return directory;
}

function persistenceGrantFixture(at = '2026-08-10T10:00:01.000Z') {
  const storageRoot = privateStateRoot('recovery-grant-persistence-');
  const externalAuditRoot = privateStateRoot('recovery-grant-audit-');
  const issuedAt = '2026-08-10T10:00:00.000Z';
  const payload = createControlPlaneRecoveryGrantPayload({
    repositoryId: REPOSITORY_ID,
    sourceControlPlaneGrantId: 'control-plane-source-grant',
    previousClosureDigest: digest('previous-closure'),
    currentClosureDigest: digest('current-closure'),
    promotionBundleDigest: digest('promotion-bundle'),
    recoveryBundleDigest: digest('recovery-bundle'),
    controlPlaneUpdateRecordDigest: digest('update-record'),
    controlPlaneJournalDigest: digest('control-plane-journal'),
    sourceTransactionState: 'ROLLBACK_REQUIRED',
    supervisorStateDigest: digest('supervisor-state'),
    supervisorGeneration: 2,
    externalAuditRoot,
    issuedAt,
    humanSigner: 'maintainer@example.test',
  });
  const envelope: ControlPlaneRecoveryGrantEnvelope = {
    payload,
    signature: 'recovery-human-signature',
  };
  const envelopeDigest = digest(canonicalJson(envelope));
  const recordPayload = {
    kind: 'persisted-control-plane-recovery-grant.v1' as const,
    state: 'reserved' as const,
    envelope,
    envelopeDigest,
    prestateDigest: controlPlaneRecoveryPrestateDigest(payload),
    receipt: null,
    failure: null,
    createdAt: issuedAt,
    updatedAt: issuedAt,
  };
  const record = {
    ...recordPayload,
    recordDigest: digest(canonicalJson(recordPayload)),
  };
  const directory = path.join(storageRoot, 'control-plane-recovery-grants');
  const recordName = `${digest(`control-plane-recovery\0${payload.grantId}`).slice('sha256:'.length)}.json`;
  const target = path.join(directory, recordName);
  return {
    storageRoot,
    externalAuditRoot,
    at,
    payload,
    envelope,
    record,
    bytes: `${canonicalJson(record)}\n`,
    directory,
    recordName,
    target,
  };
}

function makePrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function writeDurable(filePath: string, bytes: string): void {
  const descriptor = fs.openSync(filePath, 'wx', 0o600);
  try {
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, bytes, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function protectedEntries(): ProtectedCapabilityEntry[] {
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

function engineSource(
  closureDigest: string,
  engine: 'E1' | 'E2',
  restartable: boolean | 'once',
): string {
  return `#!/usr/bin/env node
import fs from 'node:fs';
const mode = process.argv[2];
const restartMarker = new URL('.restart-probed', import.meta.url);
if (mode === '--control-plane-self-test') {
  process.stdout.write(JSON.stringify({kind:'control-plane-self-test.v1',healthy:true,closureDigest:'${closureDigest}'}) + '\\n');
  process.exit(0);
}
if (mode === '--control-plane-restart-probe') {
  ${
    restartable === 'once'
      ? `if (fs.existsSync(restartMarker)) process.exit(23);
fs.writeFileSync(restartMarker, 'used\\n', {flag:'wx', mode:0o600});
process.stdout.write(JSON.stringify({kind:'control-plane-restart.v1',ready:true,closureDigest:'${closureDigest}'}) + '\\n'); process.exit(0);`
      : restartable
        ? `process.stdout.write(JSON.stringify({kind:'control-plane-restart.v1',ready:true,closureDigest:'${closureDigest}'}) + '\\n'); process.exit(0);`
        : 'process.exit(23);'
  }
}
process.stdout.write(JSON.stringify({kind:'ordinary-engine.v1',engine:'${engine}',argv:process.argv.slice(2)}) + '\\n');
process.exit(${restartable ? '0' : '23'});
`;
}

function fixture(options: { oldRestartable?: boolean | 'once' } = {}) {
  const repositoryRoot = fs.realpathSync(createFixtureRepository());
  const externalAuditRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'control-plane-recovery-audit-')),
  );
  const maintainerPolicy = JSON.parse(
    fs.readFileSync(
      path.join(SOURCE_REPOSITORY_ROOT, 'workflow/maintainer-policy.json'),
      'utf8',
    ),
  ) as { repository: { id: string; origin: string } };
  maintainerPolicy.repository = {
    id: REPOSITORY_ID,
    origin: REPOSITORY_ORIGIN,
  };
  fs.writeFileSync(
    path.join(repositoryRoot, 'workflow/maintainer-policy.json'),
    `${JSON.stringify(maintainerPolicy, null, 2)}\n`,
  );
  childProcess.execFileSync(
    'git',
    ['remote', 'add', 'origin', REPOSITORY_ORIGIN],
    {
      cwd: repositoryRoot,
      stdio: 'ignore',
    },
  );
  childProcess.execFileSync(
    'git',
    ['add', '--', 'workflow/maintainer-policy.json'],
    { cwd: repositoryRoot, stdio: 'ignore' },
  );
  childProcess.execFileSync(
    'git',
    ['commit', '-m', 'Configure recovery repository identity'],
    { cwd: repositoryRoot, stdio: 'ignore' },
  );
  const storageRoot = path.join(
    repositoryRoot,
    '.git',
    'workflow-engine',
    'intervention-control',
  );
  const mandateBinding = {
    schemaVersion: 1 as const,
    parentTaskId: 'control-plane-task',
    mandateId: '22222222-2222-4222-8222-222222222222',
    mandateDigest: '2'.repeat(64),
    changeId: 'control-plane-change',
    externalAuditRoot,
  };
  const beforeManifest = createProtectedCapabilityManifest({
    schemaVersion: 1,
    manifestPath: 'workflow/protected-capabilities.json',
    entries: protectedEntries(),
  });
  const changedEntries = protectedEntries();
  const controlIndex = changedEntries.findIndex(
    (entry) => entry.capability === 'control-plane.update',
  );
  const candidateContentDigest = digest('broken-candidate-control-plane');
  changedEntries[controlIndex] = {
    ...changedEntries[controlIndex]!,
    contentDigest: candidateContentDigest,
    closureDigest: protectedCapabilityClosureDigest(
      changedEntries[controlIndex]!.entrypoints,
      changedEntries[controlIndex]!.dependencies,
      candidateContentDigest,
    ),
  };
  const afterManifest = createProtectedCapabilityManifest({
    schemaVersion: 1,
    manifestPath: beforeManifest.manifestPath,
    entries: changedEntries,
  });
  const oldSource = engineSource(
    beforeManifest.manifestDigest,
    'E1',
    options.oldRestartable ?? true,
  );
  const candidateSource = engineSource(
    afterManifest.manifestDigest,
    'E2',
    false,
  );
  const executablePath = 'packages/workflow-engine/engine.mjs';
  const manifestPath = beforeManifest.manifestPath;
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
  const changes: ExactControlPlaneChangeV2[] = [
    {
      path: executablePath,
      beforeDigest: digest(oldSource),
      afterDigest: digest(candidateSource),
      beforeMode: '100755' as const,
      afterMode: '100755' as const,
    },
    {
      path: manifestPath,
      beforeDigest: beforeManifest.manifestDigest,
      afterDigest: afterManifest.manifestDigest,
      beforeMode: '100644' as const,
      afterMode: '100644' as const,
    },
  ].sort((left, right) => left.path.localeCompare(right.path));
  const oldArtifact = createEngineArtifact({
    sourceChangeId: 'control-plane-E1',
    sourceDigest: digest('source-E1'),
    executableDigest: digest(oldSource),
    protocolVersion: 3,
    canReadSessionSchemas: ['v4'],
    writesSessionSchema: 'v4',
    policySchemaVersion: 2,
    smokeReportDigest: digest('smoke-E1'),
  });
  const candidateArtifact = createEngineArtifact({
    sourceChangeId: mandateBinding.changeId,
    sourceDigest: digest('source-E2-broken'),
    executableDigest: digest(candidateSource),
    protocolVersion: 3,
    canReadSessionSchemas: ['v4'],
    writesSessionSchema: 'v4',
    policySchemaVersion: 2,
    smokeReportDigest: digest('smoke-E2-broken'),
  });
  const childWorkspace = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'control-plane-recovery-child-')),
  );
  fs.chmodSync(childWorkspace, 0o700);
  fs.rmdirSync(childWorkspace);
  persistInterventionPlan(storageRoot, {
    parent: {
      changeId: 'control-plane-recovery-parent',
      status: 'active',
      engineBinding: oldArtifact.executableDigest,
      sessionSchema: 'v4',
      blocker: null,
    },
    interventionChangeId: mandateBinding.changeId,
    checkpoint: {
      parentChangeId: 'control-plane-recovery-parent',
      baseOid: childProcess
        .execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: repositoryRoot,
          encoding: 'utf8',
        })
        .trim(),
      worktreeFingerprint: digest('recovery-parent-worktree'),
      trackedTreeDigest: digest('recovery-parent-tracked-tree'),
      untrackedBundleDigest: digest('recovery-parent-untracked'),
      sessionStateDigest: digest('recovery-parent-session'),
      pendingIntentDigest: digest('recovery-parent-intent'),
      engineDigest: oldArtifact.executableDigest,
      policyDigest: digest('recovery-parent-policy'),
      createdAt: '2026-08-03T09:47:00.000Z',
    },
    childWorkspace: {
      parentWorkspacePath: repositoryRoot,
      childWorkspacePath: childWorkspace,
      changeRef: `refs/heads/work/${mandateBinding.changeId}`,
    },
    now: new Date('2026-08-03T09:47:00.000Z'),
  });
  const interventionExecutable = path.join(childWorkspace, executablePath);
  fs.mkdirSync(path.dirname(interventionExecutable), {
    recursive: true,
    mode: 0o700,
  });
  fs.writeFileSync(interventionExecutable, candidateSource, { mode: 0o755 });
  fs.chmodSync(interventionExecutable, 0o755);
  const persistedCandidateArtifact = persistInterventionEngineArtifact(
    storageRoot,
    {
      parentChangeId: 'control-plane-recovery-parent',
      artifact: candidateArtifact,
      executablePath: interventionExecutable,
      now: new Date('2026-08-03T09:48:00.000Z'),
    },
  );
  const rollbackReport = Buffer.from('rollback tested\n');
  const recoveryBundle = createControlPlaneRecoveryBundleMaterial({
    repositoryId: REPOSITORY_ID,
    previousClosureDigest: beforeManifest.manifestDigest,
    restartArtifact: oldArtifact,
    restartExecutableBase64: Buffer.from(oldSource).toString('base64'),
    restartExecutableProvenanceDigest: digest(
      'generation-1-supervisor-provenance',
    ),
    previousFiles: [
      {
        path: executablePath,
        mode: '100755' as const,
        contentBase64: Buffer.from(oldSource).toString('base64'),
        contentDigest: digest(oldSource),
      },
      {
        path: manifestPath,
        mode: '100644' as const,
        contentBase64: beforeManifestBytes.toString('base64'),
        contentDigest: beforeManifest.manifestDigest,
      },
    ].sort((left, right) => left.path.localeCompare(right.path)),
    rollbackTestReportBase64: rollbackReport.toString('base64'),
    rollbackTestReportDigest: digest(rollbackReport),
  });
  const material = createControlPlanePromotionMaterial({
    mandateBinding,
    repositoryId: REPOSITORY_ID,
    frozenCandidateBundleDigest: digest('frozen-control-plane-candidate'),
    candidateDigest: controlPlaneCandidateDigestV2(changes),
    beforeClosureDigest: beforeManifest.manifestDigest,
    afterClosureDigest: afterManifest.manifestDigest,
    affectedCapabilities: ['control-plane.update'],
    behaviorChangeSummary:
      'Atomically select the exact reviewed default artifact.',
    exactChanges: changes,
    candidateArtifact,
    candidateExecutableBase64: Buffer.from(candidateSource).toString('base64'),
    candidateExecutableProvenanceDigest:
      persistedCandidateArtifact.recordDigest,
    candidateFiles: [
      {
        path: executablePath,
        mode: '100755' as const,
        contentBase64: Buffer.from(candidateSource).toString('base64'),
        contentDigest: digest(candidateSource),
      },
      {
        path: manifestPath,
        mode: '100644' as const,
        contentBase64: afterManifestBytes.toString('base64'),
        contentDigest: afterManifest.manifestDigest,
      },
    ].sort((left, right) => left.path.localeCompare(right.path)),
    recoveryBundle,
  });
  const independentReviewAttestation: ControlPlaneIndependentReviewAttestationEnvelopeV2 =
    {
      payload: {
        kind: 'control-plane-independent-review.v2',
        repositoryId: REPOSITORY_ID,
        frozenCandidateBundleDigest: material.frozenCandidateBundleDigest,
        candidateDigest: material.candidateDigest,
        promotionMaterialDigest: controlPlanePromotionMaterialDigest(material),
        beforeClosureDigest: beforeManifest.manifestDigest,
        afterClosureDigest: afterManifest.manifestDigest,
        recoveryBundleDigest: recoveryBundle.bundleDigest,
        affectedCapabilities: ['control-plane.update'],
        verdict: 'approved',
        reviewedAt: '2026-08-03T09:50:00.000Z',
        reviewSummary:
          'Verified the exact closure transition and executable rollback path.',
        reviewer: 'reviewer@example.test',
      },
      signature: 'independent-review-signature',
    };
  const promotionBundle = createControlPlanePromotionBundleV2({
    material,
    independentReviewAttestation,
  });
  const envelope: ControlPlaneGrantEnvelopeV2 = {
    payload: {
      kind: 'control-plane-grant.v2',
      grantId: 'control-promotion-broken-current',
      mandateBinding,
      repositoryId: material.repositoryId,
      frozenCandidateBundleDigest: material.frozenCandidateBundleDigest,
      candidateDigest: material.candidateDigest,
      promotionMaterialDigest: promotionBundle.promotionMaterialDigest,
      promotionBundleDigest: promotionBundle.bundleDigest,
      exactChanges: changes,
      beforeClosureDigest: beforeManifest.manifestDigest,
      afterClosureDigest: afterManifest.manifestDigest,
      affectedCapabilities: ['control-plane.update'],
      behaviorChangeSummary:
        'Atomically select the exact reviewed default artifact.',
      recoveryBundle: {
        bundleDigest: recoveryBundle.bundleDigest,
        previousClosureDigest: recoveryBundle.previousClosureDigest,
        restartArtifactDigest: oldArtifact.executableDigest,
        rollbackTestReportDigest: recoveryBundle.rollbackTestReportDigest,
      },
      independentReviewAttestationDigest:
        controlPlaneIndependentReviewAttestationDigestV2(
          independentReviewAttestation,
        ),
      updaterVersion: 2,
      oneShot: true,
      issuedAt: '2026-08-03T09:59:00.000Z',
      expiresAt: '2026-08-03T10:04:00.000Z',
      humanSigner: 'maintainer@example.test',
    },
    signature: 'control-plane-human-signature',
  };
  initializeControlPlaneSupervisorState(storageRoot, {
    repositoryId: envelope.payload.repositoryId,
    closureDigest: beforeManifest.manifestDigest,
    artifact: oldArtifact,
    executableBase64: Buffer.from(oldSource).toString('base64'),
    now: NOW,
  });
  return {
    repositoryRoot,
    storageRoot,
    beforeManifest,
    afterManifest,
    promotionBundle,
    envelope,
    oldArtifact,
    candidateArtifact,
    externalAuditRoot,
    cleanup() {
      fs.rmSync(repositoryRoot, { recursive: true, force: true });
      fs.rmSync(externalAuditRoot, { recursive: true, force: true });
      fs.rmSync(childWorkspace, { recursive: true, force: true });
    },
  };
}

async function sealedBrokenFixture() {
  const value = await setupControlPlaneProducerFixture();
  try {
    const reviewCalls = { present: 0, human: 0, sign: 0 };
    const grantCalls = { human: 0, sign: 0 };
    const produced = produceControlPlaneApprovalCandidateV2(
      fs.realpathSync(value.repository),
      value.stateRoot,
      value.frozen.candidateBundleDigest,
      {
        now: () => new Date('2026-08-10T10:03:00.000Z'),
        reviewSigner: value.signing.signer(
          CONTROL_PLANE_FIXTURE_REVIEWER,
          reviewCalls,
        ),
        verifyHumanSignature: value.signing.verifier,
        presentReviewSummary() {
          reviewCalls.present += 1;
        },
      },
    );
    const dependencies = {
      ...controlPlaneFixtureUpdaterDependencies(
        value.frozen,
        value.signing.signer(CONTROL_PLANE_FIXTURE_GRANT_SIGNER, grantCalls),
        value.signing.verifier,
        [],
        new Date('2026-08-10T10:05:00.000Z'),
      ),
      testHooks: {
        afterAtomicSwitch() {
          throw new Error('simulated crash after selecting signed V2 E2');
        },
      },
    };
    assert.throws(
      () =>
        dispatchProductionControlPlaneUpdaterCommand(
          [
            'approve-and-apply',
            produced.candidate.candidateId,
            '--task',
            value.frozen.mandateBinding.mandateTaskId,
          ],
          value.stateRoot,
          dependencies,
          fs.realpathSync(value.repository),
        ),
      /simulated crash after selecting signed V2 E2/,
    );
    const grantId = `control-plane-approval-${produced.candidate.candidateId.slice('sha256:'.length)}`;
    const record = readPersistedControlPlaneUpdate(value.stateRoot, grantId);
    assert.equal(record.kind, 'persisted-control-plane-update.v2');
    assert.equal(record.transaction.state, 'RECOVERY_VERIFIED');
    assert.equal(
      readControlPlaneSupervisorState(value.stateRoot).activeArtifact
        .artifactId,
      produced.candidate.bundle.material.candidateArtifact.artifactId,
    );
    return {
      repositoryRoot: value.repository,
      storageRoot: value.stateRoot,
      beforeManifest: record.beforeManifest,
      afterManifest: record.afterManifest,
      promotionBundle: produced.candidate.bundle,
      envelope: record.envelope,
      oldArtifact:
        produced.candidate.bundle.material.recoveryBundle.restartArtifact,
      candidateArtifact: produced.candidate.bundle.material.candidateArtifact,
      externalAuditRoot:
        produced.candidate.bundle.material.mandateBinding.externalAuditRoot,
      controlVerifier: value.signing.verifier,
      cleanup: value.cleanup,
    };
  } catch (error) {
    value.cleanup();
    throw error;
  }
}

function prepareBrokenCurrentClosure(value: ReturnType<typeof fixture>): void {
  const audit: ControlPlaneUpdaterAuditRecord[] = [];
  prepareControlPlanePromotionV2(
    value.storageRoot,
    {
      txId: 'promotion-crash-before-candidate-validation',
      envelope: value.envelope,
      beforeManifest: value.beforeManifest,
      afterManifest: value.afterManifest,
      bundle: value.promotionBundle,
    },
    controlDependencies(audit, NOW),
  );
  assert.throws(
    () =>
      executeControlPlanePromotion(
        value.storageRoot,
        value.envelope.payload.grantId,
        {
          ...controlDependencies(audit, NOW),
          testHooks: {
            afterAtomicSwitch() {
              throw new Error('simulated crash after selecting broken E2');
            },
          },
        },
      ),
    /simulated crash after selecting broken E2/,
  );
  assert.equal(
    readControlPlaneSupervisorState(value.storageRoot).activeArtifact
      .artifactId,
    value.candidateArtifact.artifactId,
  );
}

function controlDependencies(
  audit: ControlPlaneUpdaterAuditRecord[],
  now: Date,
  controlVerifier?: (
    payload: string,
    signature: string,
    signer: string,
    namespace: string,
  ) => boolean,
) {
  return {
    now: () => now,
    consumedGrantIds: new Set<string>(),
    verifyHumanSignature(
      payload: string,
      signature: string,
      signer: string,
      namespace: string,
    ) {
      if (controlVerifier !== undefined) {
        return controlVerifier(payload, signature, signer, namespace);
      }
      if (namespace === CONTROL_PLANE_SIGNATURE_NAMESPACE_V2) {
        return (
          signature === 'control-plane-human-signature' &&
          signer === 'maintainer@example.test'
        );
      }
      if (namespace === CONTROL_PLANE_REVIEW_SIGNATURE_NAMESPACE_V2) {
        return (
          signature === 'independent-review-signature' &&
          signer === 'reviewer@example.test'
        );
      }
      return false;
    },
    auditSink: {
      append(record: ControlPlaneUpdaterAuditRecord) {
        const previous = audit.find(
          (candidate) => candidate.recordId === record.recordId,
        );
        if (previous) assert.deepEqual(previous, record);
        else audit.push(record);
      },
    },
  };
}

function recoveryDependencies(
  controlAudit: ControlPlaneUpdaterAuditRecord[],
  recoveryAudit: ControlPlaneRecoveryAuditRecord[],
  now: Date,
  controlVerifier?: (
    payload: string,
    signature: string,
    signer: string,
    namespace: string,
  ) => boolean,
): ControlPlaneRecoveryExecutorDependencies {
  return {
    ...controlDependencies(controlAudit, now, controlVerifier),
    verifyHumanSignature(
      payload: string,
      signature: string,
      signer: string,
      namespace: string,
    ) {
      if (namespace === HARNESS_RECOVERY_SIGNATURE_NAMESPACE) {
        assert.equal(signature, 'recovery-human-signature');
        assert.equal(signer, 'maintainer@example.test');
        assert.doesNotThrow(() => JSON.parse(payload));
        return true;
      }
      return controlDependencies(
        controlAudit,
        now,
        controlVerifier,
      ).verifyHumanSignature(payload, signature, signer, namespace);
    },
    recoveryAuditSink: {
      append(record: ControlPlaneRecoveryAuditRecord) {
        const previous = recoveryAudit.find(
          (candidate) => candidate.recordId === record.recordId,
        );
        if (previous) assert.deepEqual(previous, record);
        else recoveryAudit.push(record);
      },
    },
  };
}

function appendRecoveryAuditIdempotently(
  audit: ControlPlaneRecoveryAuditRecord[],
  record: ControlPlaneRecoveryAuditRecord,
): void {
  const previous = audit.find(
    (candidate) => candidate.recordId === record.recordId,
  );
  if (previous) assert.deepEqual(previous, record);
  else audit.push(record);
}

function runWorkflowLauncher(repositoryRoot: string, argv: string[]) {
  return childProcess.spawnSync(
    process.execPath,
    ['--experimental-strip-types', WORKFLOW_LAUNCHER, ...argv],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );
}

function captureHarness(run: () => number): {
  status: number;
  stdout: string;
  stderr: string;
} {
  let stdout = '';
  let stderr = '';
  const previousStdout = process.stdout.write.bind(process.stdout);
  const previousStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    return { status: run(), stdout, stderr };
  } finally {
    process.stdout.write = previousStdout;
    process.stderr.write = previousStderr;
  }
}

test('sealed bootstrap signs an exact Recovery Grant and uniquely restores a control plane that cannot launch', async () => {
  const value = await sealedBrokenFixture();
  const controlAudit: ControlPlaneUpdaterAuditRecord[] = [];
  const recoveryAudit: ControlPlaneRecoveryAuditRecord[] = [];
  const signedNamespaces: string[] = [];
  const recoveryNow = new Date('2026-08-10T10:06:00.000Z');
  const controlAt = (now: Date) =>
    controlDependencies(controlAudit, now, value.controlVerifier);
  const recoveryAt = (now: Date) =>
    recoveryDependencies(
      controlAudit,
      recoveryAudit,
      now,
      value.controlVerifier,
    );
  try {
    const blocked = runWorkflowLauncher(value.repositoryRoot, [
      'ordinary-command',
    ]);
    assert.notEqual(blocked.status, 0);
    assert.equal(blocked.stdout, '');
    assert.match(blocked.stderr, /CONTROL_PLANE_SUPERVISOR_NOT_TERMINAL/);

    let crashBeforeRecoveryConsumption = true;
    const interrupted = captureHarness(() =>
      runHarnessBootstrapCli(
        ['control-plane', 'rollback', value.envelope.payload.grantId, '--json'],
        value.repositoryRoot,
        {
          now: () => recoveryNow,
          recoverySigner: {
            assertHumanPresent() {},
            identity: () => 'maintainer@example.test',
            sign(payload, namespace) {
              assert.equal(namespace, HARNESS_RECOVERY_SIGNATURE_NAMESPACE);
              signedNamespaces.push(namespace);
              const parsed = JSON.parse(payload) as Record<string, unknown>;
              assert.equal(parsed.operation, 'rollback-control-plane');
              assert.equal(
                parsed.repositoryId,
                value.envelope.payload.repositoryId,
              );
              assert.equal(
                parsed.previousClosureDigest,
                value.beforeManifest.manifestDigest,
              );
              assert.equal(
                parsed.currentClosureDigest,
                value.afterManifest.manifestDigest,
              );
              return 'recovery-human-signature';
            },
            verify() {},
          },
          verifyHumanSignature: recoveryAt(recoveryNow).verifyHumanSignature,
          controlPlaneAuditSink: controlAt(recoveryNow).auditSink,
          recoveryAuditSink: {
            append(record) {
              appendRecoveryAuditIdempotently(recoveryAudit, record);
              if (
                record.event === 'consumed' &&
                crashBeforeRecoveryConsumption
              ) {
                crashBeforeRecoveryConsumption = false;
                throw new Error(
                  'simulated crash after rollback audit before consumption',
                );
              }
            },
          },
          presentRecoverySummary(summary) {
            assert.match(summary.humanReadable, /rollback-control-plane/);
          },
        },
      ),
    );
    assert.notEqual(interrupted.status, 0);
    assert.match(
      interrupted.stderr,
      /simulated crash after rollback audit before consumption/,
    );
    const reserved = findPersistedControlPlaneRecoveryGrantForSource(
      value.storageRoot,
      value.envelope.payload.grantId,
    );
    assert.equal(
      reserved?.state,
      'completion-pending',
      'a consumed external audit must never describe a merely reserved local grant',
    );
    const generationAfterRollback = readControlPlaneSupervisorState(
      value.storageRoot,
    ).generation;
    assert.equal(generationAfterRollback, 3);
    assert.equal(
      readControlPlaneSupervisorState(value.storageRoot).activeArtifact
        .artifactId,
      value.oldArtifact.artifactId,
    );

    const resumeNow = new Date(recoveryNow.getTime() + 1_000);
    const result = captureHarness(() =>
      runHarnessBootstrapCli(
        ['control-plane', 'rollback', value.envelope.payload.grantId, '--json'],
        value.repositoryRoot,
        {
          now: () => resumeNow,
          recoverySigner: {
            assertHumanPresent() {
              assert.fail(
                'reserved recovery must resume the exact signed envelope',
              );
            },
            identity: () => 'maintainer@example.test',
            sign: () => 'must-not-resign',
            verify() {},
          },
          verifyHumanSignature: recoveryAt(resumeNow).verifyHumanSignature,
          controlPlaneAuditSink: controlAt(resumeNow).auditSink,
          recoveryAuditSink: {
            append(record) {
              appendRecoveryAuditIdempotently(recoveryAudit, record);
            },
          },
        },
      ),
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(signedNamespaces, [HARNESS_RECOVERY_SIGNATURE_NAMESPACE]);
    const output = JSON.parse(result.stdout) as {
      ok: boolean;
      result: {
        action: string;
        recoveryGrantId: string;
        effectsPerformed: boolean;
        receipt: { result: string; receiptDigest: string };
      };
    };
    assert.equal(output.ok, true);
    assert.equal(output.result.action, 'rollback-control-plane');
    assert.equal(
      output.result.effectsPerformed,
      false,
      'terminal completion replay must not claim a second rollback effect',
    );
    assert.equal(output.result.receipt.result, 'rolled-back');
    assert.equal(
      readControlPlaneSupervisorState(value.storageRoot).generation,
      generationAfterRollback,
      'completion replay must not perform a second rollback selection',
    );

    const tombstone = readPersistedControlPlaneRecoveryGrant(
      value.storageRoot,
      output.result.recoveryGrantId,
    );
    assert.equal(tombstone.state, 'consumed');
    assert.equal(
      tombstone.receipt?.receiptDigest,
      output.result.receipt.receiptDigest,
    );
    assert.equal(tombstone.envelope.payload.uses, 1);
    assert.equal(tombstone.envelope.payload.oneShot, true);
    assert.equal(
      Date.parse(tombstone.envelope.payload.expiresAt) -
        Date.parse(tombstone.envelope.payload.issuedAt),
      5 * 60 * 1000,
    );
    assert.deepEqual(
      recoveryAudit.map(({ event }) => event),
      ['authorized', 'rolled-back', 'consumed'],
    );
    assert.equal(
      recoveryAudit.at(-1)?.receiptDigest,
      output.result.receipt.receiptDigest,
    );

    const selected = resolveControlPlaneEngineSelection(value.storageRoot);
    assert.equal(
      selected?.activeArtifact.artifactId,
      value.oldArtifact.artifactId,
    );
    const resumed = runWorkflowLauncher(value.repositoryRoot, [
      '--control-plane-restart-probe',
    ]);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(JSON.parse(resumed.stdout).ready, true);

    const replay = captureHarness(() =>
      runHarnessBootstrapCli(
        ['control-plane', 'rollback', value.envelope.payload.grantId, '--json'],
        value.repositoryRoot,
        {
          now: () => new Date(recoveryNow.getTime() + 60_000),
          recoverySigner: {
            assertHumanPresent() {
              assert.fail(
                'replay must be rejected before asking for a signature',
              );
            },
            identity: () => 'maintainer@example.test',
            sign: () => 'must-not-sign',
            verify() {},
          },
          verifyHumanSignature: recoveryAt(recoveryNow).verifyHumanSignature,
          controlPlaneAuditSink: controlAt(recoveryNow).auditSink,
          recoveryAuditSink: { append() {} },
        },
      ),
    );
    assert.notEqual(replay.status, 0);
    assert.match(replay.stderr, /HARNESS_RECOVERY_GRANT_ALREADY_CONSUMED/);

    const usage = captureHarness(() => runHarnessBootstrapCli(['--help']));
    assert.equal(usage.status, 0);
    assert.match(
      usage.stdout,
      /control-plane rollback <control-plane-grant-id>/,
    );
  } finally {
    value.cleanup();
  }
});

test('Recovery Grant rejects unknown fields, excessive TTL, expiry, and stale exact-state bindings before effect', () => {
  const value = fixture();
  const controlAudit: ControlPlaneUpdaterAuditRecord[] = [];
  const recoveryAudit: ControlPlaneRecoveryAuditRecord[] = [];
  try {
    prepareBrokenCurrentClosure(value);
    const dependencies = recoveryDependencies(
      controlAudit,
      recoveryAudit,
      RECOVERY_NOW,
    );
    const preflight = preflightControlPlaneRecoveryRollback(
      value.storageRoot,
      value.envelope.payload.grantId,
      {
        humanSigner: 'maintainer@example.test',
        issuedAt: RECOVERY_NOW.toISOString(),
      },
      dependencies,
    );
    const envelope: ControlPlaneRecoveryGrantEnvelope = {
      payload: preflight.payload,
      signature: 'recovery-human-signature',
    };
    assert.match(
      canonicalControlPlaneRecoveryGrantPayload(envelope.payload),
      /rollback-control-plane/,
    );

    const unknownField = structuredClone(envelope) as unknown as {
      payload: Record<string, unknown>;
      signature: string;
    };
    unknownField.payload.arbitraryState = { attacker: 'supplied-diff' };
    assert.throws(
      () =>
        executeControlPlaneRecoveryRollback(
          value.storageRoot,
          unknownField as unknown as ControlPlaneRecoveryGrantEnvelope,
          dependencies,
        ),
      errorWithCode('HARNESS_RECOVERY_GRANT_INVALID'),
    );

    const unsupportedOperation = structuredClone(envelope) as unknown as {
      payload: Record<string, unknown>;
      signature: string;
    };
    unsupportedOperation.payload.operation = 'restore-trust-root';
    assert.throws(
      () =>
        executeControlPlaneRecoveryRollback(
          value.storageRoot,
          unsupportedOperation as unknown as ControlPlaneRecoveryGrantEnvelope,
          dependencies,
        ),
      errorWithCode('HARNESS_RECOVERY_GRANT_INVALID'),
    );

    const excessiveTtl = structuredClone(envelope);
    excessiveTtl.payload.expiresAt = new Date(
      RECOVERY_NOW.getTime() + 5 * 60 * 1000 + 1,
    ).toISOString();
    assert.throws(
      () =>
        executeControlPlaneRecoveryRollback(
          value.storageRoot,
          excessiveTtl,
          dependencies,
        ),
      errorWithCode('HARNESS_RECOVERY_GRANT_TTL_INVALID'),
    );

    const staleBinding: ControlPlaneRecoveryGrantEnvelope = {
      payload: createControlPlaneRecoveryGrantPayload({
        repositoryId: envelope.payload.repositoryId,
        sourceControlPlaneGrantId: envelope.payload.sourceControlPlaneGrantId,
        previousClosureDigest: envelope.payload.previousClosureDigest,
        currentClosureDigest: envelope.payload.currentClosureDigest,
        promotionBundleDigest: envelope.payload.promotionBundleDigest,
        recoveryBundleDigest: envelope.payload.recoveryBundleDigest,
        controlPlaneUpdateRecordDigest:
          envelope.payload.controlPlaneUpdateRecordDigest,
        controlPlaneJournalDigest: envelope.payload.controlPlaneJournalDigest,
        sourceTransactionState: envelope.payload.sourceTransactionState,
        supervisorStateDigest: digest('attacker-state'),
        supervisorGeneration: envelope.payload.supervisorGeneration,
        externalAuditRoot: envelope.payload.externalAuditRoot,
        issuedAt: envelope.payload.issuedAt,
        humanSigner: envelope.payload.humanSigner,
      }),
      signature: envelope.signature,
    };
    assert.throws(
      () =>
        executeControlPlaneRecoveryRollback(
          value.storageRoot,
          staleBinding,
          dependencies,
        ),
      errorWithCode('HARNESS_RECOVERY_STATE_BINDING_MISMATCH'),
    );

    for (const [signature, signedNamespace] of [
      [
        'maintenance-grant-signature',
        'expense-app.workflow.maintainer-grant.v1',
      ],
      ['task-mandate-signature', 'HARNESS_TASK_MANDATE_V1'],
    ] as const) {
      const wrongDomainReplay = structuredClone(envelope);
      wrongDomainReplay.signature = signature;
      assert.throws(
        () =>
          executeControlPlaneRecoveryRollback(
            value.storageRoot,
            wrongDomainReplay,
            {
              ...dependencies,
              verifyHumanSignature(
                _payload,
                observedSignature,
                _signer,
                namespace,
              ) {
                return (
                  observedSignature === signature &&
                  namespace === signedNamespace
                );
              },
            },
          ),
        errorWithCode('HARNESS_RECOVERY_GRANT_SIGNATURE_INVALID'),
      );
    }

    assert.throws(
      () =>
        executeControlPlaneRecoveryRollback(value.storageRoot, envelope, {
          ...dependencies,
          now: () => new Date(Date.parse(envelope.payload.expiresAt) + 1),
        }),
      errorWithCode('HARNESS_RECOVERY_GRANT_EXPIRED'),
    );
    assert.equal(
      findPersistedControlPlaneRecoveryGrantForSource(
        value.storageRoot,
        value.envelope.payload.grantId,
      ),
      null,
      'invalid, stale, wrong-domain, and expired admission must not reserve',
    );
    assert.equal(
      readControlPlaneSupervisorState(value.storageRoot).activeArtifact
        .artifactId,
      value.candidateArtifact.artifactId,
    );
    assert.equal(recoveryAudit.length, 0);

    assert.throws(
      () =>
        executeControlPlaneRecoveryRollback(value.storageRoot, envelope, {
          ...dependencies,
          recoveryAuditSink: {
            append(record) {
              assert.equal(record.event, 'authorized');
              throw new Error('simulated external audit outage');
            },
          },
        }),
      /simulated external audit outage/,
    );
    const reserved = findPersistedControlPlaneRecoveryGrantForSource(
      value.storageRoot,
      value.envelope.payload.grantId,
    );
    assert.equal(reserved?.state, 'reserved');
    assert.equal(
      readControlPlaneSupervisorState(value.storageRoot).activeArtifact
        .artifactId,
      value.candidateArtifact.artifactId,
      'audit failure before rollback must leave the selected closure untouched',
    );

    const expiredAt = new Date(Date.parse(envelope.payload.expiresAt) + 1);
    const expiryAudit: ControlPlaneRecoveryAuditRecord[] = [];
    assert.throws(
      () =>
        executeControlPlaneRecoveryRollback(
          value.storageRoot,
          envelope,
          recoveryDependencies(controlAudit, expiryAudit, expiredAt),
        ),
      errorWithCode('HARNESS_RECOVERY_GRANT_EXPIRED'),
    );
    const expired = findPersistedControlPlaneRecoveryGrantForSource(
      value.storageRoot,
      value.envelope.payload.grantId,
    );
    assert.equal(expired?.state, 'expired');
    assert.deepEqual(
      expiryAudit.map(({ event }) => event),
      ['authorized', 'expired'],
    );
    const renewedAt = new Date(expiredAt.getTime() + 1);
    let renewalSignatures = 0;
    const renewed = captureHarness(() =>
      runHarnessBootstrapCli(
        ['control-plane', 'rollback', value.envelope.payload.grantId, '--json'],
        value.repositoryRoot,
        {
          now: () => renewedAt,
          recoverySigner: {
            assertHumanPresent() {},
            identity: () => 'maintainer@example.test',
            sign(_payload, namespace) {
              assert.equal(namespace, HARNESS_RECOVERY_SIGNATURE_NAMESPACE);
              renewalSignatures += 1;
              return 'recovery-human-signature';
            },
            verify() {},
          },
          verifyHumanSignature: recoveryDependencies(
            controlAudit,
            expiryAudit,
            renewedAt,
          ).verifyHumanSignature,
          controlPlaneAuditSink: controlDependencies(controlAudit, renewedAt)
            .auditSink,
          recoveryAuditSink: {
            append(record) {
              appendRecoveryAuditIdempotently(expiryAudit, record);
            },
          },
          presentRecoverySummary() {},
        },
      ),
    );
    assert.equal(renewed.status, 0, renewed.stderr);
    assert.equal(renewalSignatures, 1);
    const renewedOutput = JSON.parse(renewed.stdout) as {
      ok: boolean;
      result: {
        recoveryGrantId: string;
        effectsPerformed: boolean;
        record: { state: string };
      };
    };
    assert.equal(renewedOutput.ok, true);
    assert.equal(renewedOutput.result.effectsPerformed, true);
    assert.equal(renewedOutput.result.record.state, 'consumed');
    assert.notEqual(
      renewedOutput.result.recoveryGrantId,
      envelope.payload.grantId,
    );
    assert.equal(
      readPersistedControlPlaneRecoveryGrant(
        value.storageRoot,
        envelope.payload.grantId,
      ).state,
      'expired',
    );
    assert.equal(
      readPersistedControlPlaneRecoveryGrant(
        value.storageRoot,
        renewedOutput.result.recoveryGrantId,
      ).state,
      'consumed',
    );
    assert.equal(
      findPersistedControlPlaneRecoveryGrantForSource(
        value.storageRoot,
        value.envelope.payload.grantId,
      )?.envelope.payload.grantId,
      renewedOutput.result.recoveryGrantId,
      'source lookup must select the exact current terminal grant while preserving expired history',
    );
  } finally {
    value.cleanup();
  }
});

test('Recovery Grant treats expiresAt as exclusive for fresh and reserved admission', () => {
  const value = fixture();
  const controlAudit: ControlPlaneUpdaterAuditRecord[] = [];
  const recoveryAudit: ControlPlaneRecoveryAuditRecord[] = [];
  try {
    prepareBrokenCurrentClosure(value);
    const preflight = preflightControlPlaneRecoveryRollback(
      value.storageRoot,
      value.envelope.payload.grantId,
      {
        humanSigner: 'maintainer@example.test',
        issuedAt: RECOVERY_NOW.toISOString(),
      },
      recoveryDependencies(controlAudit, recoveryAudit, RECOVERY_NOW),
    );
    assert.equal(
      preflight.summary.approvalDigest,
      digest(canonicalControlPlaneRecoveryGrantPayload(preflight.payload)),
    );
    assert.equal(
      preflight.summary.sourceTransactionState,
      preflight.payload.sourceTransactionState,
    );
    assert.equal(
      preflight.summary.externalAuditRoot,
      preflight.payload.externalAuditRoot,
    );
    assert.equal(preflight.summary.humanSigner, preflight.payload.humanSigner);
    assert.match(
      preflight.summary.humanReadable,
      new RegExp(preflight.payload.grantId),
    );
    assert.match(
      preflight.summary.humanReadable,
      new RegExp(preflight.payload.promotionBundleDigest),
    );
    assert.match(
      preflight.summary.humanReadable,
      new RegExp(preflight.payload.externalAuditRoot),
    );
    const envelope: ControlPlaneRecoveryGrantEnvelope = {
      payload: preflight.payload,
      signature: 'recovery-human-signature',
    };
    const expiresAt = new Date(Date.parse(envelope.payload.expiresAt));

    assert.throws(
      () =>
        executeControlPlaneRecoveryRollback(
          value.storageRoot,
          envelope,
          recoveryDependencies(controlAudit, recoveryAudit, expiresAt),
        ),
      errorWithCode('HARNESS_RECOVERY_GRANT_EXPIRED'),
    );
    assert.equal(
      findPersistedControlPlaneRecoveryGrantForSource(
        value.storageRoot,
        value.envelope.payload.grantId,
      ),
      null,
      'an unreserved grant must not begin an effect at the exact expiry boundary',
    );

    const beforeExpiry = new Date(expiresAt.getTime() - 1);
    assert.throws(
      () =>
        executeControlPlaneRecoveryRollback(value.storageRoot, envelope, {
          ...recoveryDependencies(controlAudit, recoveryAudit, beforeExpiry),
          recoveryAuditSink: {
            append(record) {
              appendRecoveryAuditIdempotently(recoveryAudit, record);
              if (record.event === 'authorized') {
                throw new Error('reserve without rollback effect');
              }
            },
          },
        }),
      /reserve without rollback effect/,
    );
    assert.equal(
      findPersistedControlPlaneRecoveryGrantForSource(
        value.storageRoot,
        value.envelope.payload.grantId,
      )?.state,
      'reserved',
    );

    const terminalAudit: ControlPlaneRecoveryAuditRecord[] = [];
    assert.throws(
      () =>
        executeControlPlaneRecoveryRollback(
          value.storageRoot,
          envelope,
          recoveryDependencies(controlAudit, terminalAudit, expiresAt),
        ),
      errorWithCode('HARNESS_RECOVERY_GRANT_EXPIRED'),
    );
    assert.equal(
      findPersistedControlPlaneRecoveryGrantForSource(
        value.storageRoot,
        value.envelope.payload.grantId,
      )?.state,
      'expired',
      'an exact-boundary reserved grant must terminalize before any rollback effect',
    );
    assert.deepEqual(
      terminalAudit.map(({ event }) => event),
      ['authorized', 'expired'],
    );
    assert.equal(
      readControlPlaneSupervisorState(value.storageRoot).activeArtifact
        .artifactId,
      value.candidateArtifact.artifactId,
    );
  } finally {
    value.cleanup();
  }
});

test('Recovery Grant source lookup tolerates only its own crash-orphan temporary record', () => {
  const value = fixture();
  const controlAudit: ControlPlaneUpdaterAuditRecord[] = [];
  const recoveryAudit: ControlPlaneRecoveryAuditRecord[] = [];
  try {
    prepareBrokenCurrentClosure(value);
    const dependencies = recoveryDependencies(
      controlAudit,
      recoveryAudit,
      RECOVERY_NOW,
    );
    const preflight = preflightControlPlaneRecoveryRollback(
      value.storageRoot,
      value.envelope.payload.grantId,
      {
        humanSigner: 'maintainer@example.test',
        issuedAt: RECOVERY_NOW.toISOString(),
      },
      dependencies,
    );
    const envelope: ControlPlaneRecoveryGrantEnvelope = {
      payload: preflight.payload,
      signature: 'recovery-human-signature',
    };
    assert.throws(
      () =>
        executeControlPlaneRecoveryRollback(value.storageRoot, envelope, {
          ...dependencies,
          recoveryAuditSink: {
            append(record) {
              if (record.event === 'authorized') {
                throw new Error('reserve before simulated hard crash');
              }
            },
          },
        }),
      /reserve before simulated hard crash/,
    );

    const directory = path.join(
      value.storageRoot,
      'control-plane-recovery-grants',
    );
    const recordName = fs
      .readdirSync(directory)
      .find((entry) => /^[0-9a-f]{64}\.json$/.test(entry));
    assert.ok(recordName);
    const orphanName = `.${recordName}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.copyFileSync(
      path.join(directory, recordName),
      path.join(directory, orphanName),
      fs.constants.COPYFILE_EXCL,
    );
    fs.chmodSync(path.join(directory, orphanName), 0o600);

    assert.equal(
      findPersistedControlPlaneRecoveryGrantForSource(
        value.storageRoot,
        value.envelope.payload.grantId,
      )?.state,
      'reserved',
    );
    assert.equal(
      fs.existsSync(path.join(directory, orphanName)),
      false,
      'a verified orphan created by the atomic writer must be cleaned',
    );

    fs.writeFileSync(path.join(directory, 'attacker.tmp'), '', {
      mode: 0o600,
      flag: 'wx',
    });
    assert.throws(
      () =>
        findPersistedControlPlaneRecoveryGrantForSource(
          value.storageRoot,
          value.envelope.payload.grantId,
        ),
      errorWithCode('HARNESS_RECOVERY_RECORD_CORRUPT'),
    );
  } finally {
    value.cleanup();
  }
});

test('Recovery Grant exact replay repairs a legacy partial final target without overwriting another record', () => {
  const value = persistenceGrantFixture();
  makePrivateDirectory(value.directory);
  const envelopeDigestAnchor = `,"envelopeDigest":"${value.record.envelopeDigest}",`;
  const envelopeDigestEnd =
    value.bytes.indexOf(envelopeDigestAnchor) + envelopeDigestAnchor.length;
  assert.ok(envelopeDigestEnd > envelopeDigestAnchor.length);
  assert.ok(envelopeDigestEnd < value.bytes.length);
  const prefix = value.bytes.slice(0, envelopeDigestEnd);
  writeDurable(value.target, prefix);

  const repaired = reservePersistedControlPlaneRecoveryGrant(
    value.storageRoot,
    value.envelope,
    '2026-08-10T10:00:45.000Z',
  );
  assert.deepEqual(repaired, value.record);
  assert.equal(fs.readFileSync(value.target, 'utf8'), value.bytes);
  assert.equal(fs.lstatSync(value.target).nlink, 1);
  assert.deepEqual(fs.readdirSync(value.directory), [value.recordName]);

  const different = persistenceGrantFixture();
  makePrivateDirectory(different.directory);
  writeDurable(different.target, '{"unknown":"record"');
  assert.throws(
    () =>
      reservePersistedControlPlaneRecoveryGrant(
        different.storageRoot,
        different.envelope,
        different.at,
      ),
    errorWithCode('HARNESS_RECOVERY_RECORD_CORRUPT'),
  );
  assert.equal(
    fs.readFileSync(different.target, 'utf8'),
    '{"unknown":"record"',
    'a non-prefix final residue must never be deleted or overwritten',
  );
});

test('Recovery Grant rejects ambiguous legacy final residue and state-binding reuse', () => {
  const ambiguous = persistenceGrantFixture();
  makePrivateDirectory(ambiguous.directory);
  writeDurable(ambiguous.target, '');
  assert.throws(
    () =>
      reservePersistedControlPlaneRecoveryGrant(
        ambiguous.storageRoot,
        ambiguous.envelope,
        '2026-08-10T10:00:02.000Z',
      ),
    errorWithCode('HARNESS_RECOVERY_RECORD_CORRUPT'),
  );
  assert.equal(fs.readFileSync(ambiguous.target, 'utf8'), '');

  const differentState = persistenceGrantFixture();
  makePrivateDirectory(differentState.directory);
  writeDurable(differentState.target, differentState.bytes.slice(0, 1));
  const reusedIdentity = structuredClone(differentState.envelope);
  reusedIdentity.payload.currentClosureDigest = digest(
    'different-current-closure',
  );
  assert.throws(
    () =>
      reservePersistedControlPlaneRecoveryGrant(
        differentState.storageRoot,
        reusedIdentity,
        differentState.at,
      ),
    errorWithCode('HARNESS_RECOVERY_GRANT_INVALID'),
  );
  assert.equal(fs.readFileSync(differentState.target, 'utf8'), '{');

  const differentSignature = persistenceGrantFixture();
  makePrivateDirectory(differentSignature.directory);
  const commonPrefixEnd = differentSignature.bytes.indexOf(
    differentSignature.envelope.signature,
  );
  assert.ok(commonPrefixEnd > 0);
  const commonPrefix = differentSignature.bytes.slice(0, commonPrefixEnd);
  writeDurable(differentSignature.target, commonPrefix);
  const resigned = structuredClone(differentSignature.envelope);
  resigned.signature = 'different-valid-recovery-signature';
  assert.throws(
    () =>
      reservePersistedControlPlaneRecoveryGrant(
        differentSignature.storageRoot,
        resigned,
        differentSignature.at,
      ),
    errorWithCode('HARNESS_RECOVERY_RECORD_CORRUPT'),
  );
  assert.equal(
    fs.readFileSync(differentSignature.target, 'utf8'),
    commonPrefix,
  );
});

test('Recovery Grant rejects a same-target preparation for different record bytes before publish', () => {
  const previous = persistenceGrantFixture();
  const requestedEnvelope = structuredClone(previous.envelope);
  requestedEnvelope.signature = 'different-exact-record-signature';
  const requested = {
    ...previous,
    at: '2026-08-10T10:00:02.000Z',
    envelope: requestedEnvelope,
  };
  makePrivateDirectory(previous.directory);
  const previousPreparation = path.join(
    previous.directory,
    `.${previous.recordName}.absent.${previous.record.recordDigest.slice('sha256:'.length)}.${crypto.randomUUID()}.tmp`,
  );
  writeDurable(previousPreparation, previous.bytes);

  assert.throws(
    () =>
      reservePersistedControlPlaneRecoveryGrant(
        requested.storageRoot,
        requested.envelope,
        requested.at,
      ),
    errorWithCode('HARNESS_RECOVERY_RECORD_CORRUPT'),
  );
  assert.equal(fs.existsSync(previousPreparation), true);
  assert.equal(fs.readFileSync(previousPreparation, 'utf8'), previous.bytes);
  assert.equal(fs.existsSync(requested.target), false);
});

test('Recovery Grant cleanup quarantines a substituted preparation instead of unlinking it', () => {
  const value = persistenceGrantFixture();
  makePrivateDirectory(value.directory);
  const preparation = path.join(
    value.directory,
    `.${value.recordName}.absent.${value.record.recordDigest.slice('sha256:'.length)}.${crypto.randomUUID()}.tmp`,
  );
  writeDurable(preparation, value.bytes);
  const originalRename = fs.renameSync;
  let quarantinedPath: string | null = null;
  let preservedExactPath: string | null = null;
  fs.renameSync = ((source: fs.PathLike, destination: fs.PathLike) => {
    originalRename(source, destination);
    if (String(source) === preparation) {
      quarantinedPath = String(destination);
      preservedExactPath = `${String(destination)}.exact`;
      originalRename(destination, preservedExactPath);
      writeDurable(String(destination), 'attacker-substitution');
    }
  }) as typeof fs.renameSync;
  try {
    assert.throws(
      () =>
        reservePersistedControlPlaneRecoveryGrant(
          value.storageRoot,
          value.envelope,
          value.at,
        ),
      errorWithCode('HARNESS_RECOVERY_RECORD_CORRUPT'),
    );
  } finally {
    fs.renameSync = originalRename;
  }
  assert.ok(quarantinedPath);
  assert.ok(preservedExactPath);
  assert.equal(
    fs.readFileSync(quarantinedPath, 'utf8'),
    'attacker-substitution',
  );
  assert.equal(fs.readFileSync(preservedExactPath, 'utf8'), value.bytes);
  assert.equal(fs.existsSync(value.target), false);
});

test('Recovery Grant cleanup never path-unlinks a quarantined inode', () => {
  const value = persistenceGrantFixture();
  makePrivateDirectory(value.directory);
  const preparation = path.join(
    value.directory,
    `.${value.recordName}.absent.${value.record.recordDigest.slice('sha256:'.length)}.${crypto.randomUUID()}.tmp`,
  );
  writeDurable(preparation, value.bytes);
  const originalUnlink = fs.unlinkSync;
  let quarantineUnlinkAttempted = false;
  fs.unlinkSync = ((filePath: fs.PathLike) => {
    if (
      String(filePath).includes('control-plane-recovery-cleanup-quarantine')
    ) {
      quarantineUnlinkAttempted = true;
    }
    return originalUnlink(filePath);
  }) as typeof fs.unlinkSync;
  try {
    reservePersistedControlPlaneRecoveryGrant(
      value.storageRoot,
      value.envelope,
      value.at,
    );
  } finally {
    fs.unlinkSync = originalUnlink;
  }
  assert.equal(
    quarantineUnlinkAttempted,
    false,
    'verified cleanup must detach by atomic replacement and preserve quarantined residue',
  );
  assert.equal(fs.existsSync(value.target), true);
});

test('Recovery Grant exact replay reconciles no-replace publish and partial preparation crash windows', () => {
  const published = persistenceGrantFixture();
  makePrivateDirectory(published.directory);
  const publishedPreparation = path.join(
    published.directory,
    `.${published.recordName}.absent.${published.record.recordDigest.slice('sha256:'.length)}.${crypto.randomUUID()}.tmp`,
  );
  writeDurable(publishedPreparation, published.bytes);
  fs.linkSync(publishedPreparation, published.target);
  assert.equal(fs.lstatSync(published.target).nlink, 2);

  const reconciled = reservePersistedControlPlaneRecoveryGrant(
    published.storageRoot,
    published.envelope,
    published.at,
  );
  assert.deepEqual(reconciled, published.record);
  assert.equal(fs.existsSync(publishedPreparation), false);
  assert.equal(fs.lstatSync(published.target).nlink, 1);

  const quarantined = persistenceGrantFixture();
  makePrivateDirectory(quarantined.directory);
  const quarantinedPreparation = path.join(
    quarantined.directory,
    `.${quarantined.recordName}.absent.${quarantined.record.recordDigest.slice('sha256:'.length)}.${crypto.randomUUID()}.tmp`,
  );
  writeDurable(quarantinedPreparation, quarantined.bytes);
  fs.linkSync(quarantinedPreparation, quarantined.target);
  const cleanupRoot = path.join(
    quarantined.storageRoot,
    'control-plane-recovery-cleanup-quarantine',
  );
  makePrivateDirectory(cleanupRoot);
  const cleanupOperation = fs.mkdtempSync(path.join(cleanupRoot, 'cleanup-'));
  fs.chmodSync(cleanupOperation, 0o700);
  const quarantinedAlias = path.join(cleanupOperation, 'residue');
  fs.renameSync(quarantinedPreparation, quarantinedAlias);
  assert.equal(fs.lstatSync(quarantined.target).nlink, 2);

  const recoveredQuarantine = reservePersistedControlPlaneRecoveryGrant(
    quarantined.storageRoot,
    quarantined.envelope,
    quarantined.at,
  );
  assert.deepEqual(recoveredQuarantine, quarantined.record);
  assert.equal(fs.lstatSync(quarantined.target).nlink, 1);
  assert.equal(fs.existsSync(quarantinedAlias), true);
  assert.equal(fs.readFileSync(quarantinedAlias, 'utf8'), quarantined.bytes);

  const detached = persistenceGrantFixture();
  makePrivateDirectory(detached.directory);
  const detachedPreparation = path.join(
    detached.directory,
    `.${detached.recordName}.absent.${detached.record.recordDigest.slice('sha256:'.length)}.${crypto.randomUUID()}.tmp`,
  );
  writeDurable(detachedPreparation, detached.bytes);
  fs.linkSync(detachedPreparation, detached.target);
  const detachedCleanupRoot = path.join(
    detached.storageRoot,
    'control-plane-recovery-cleanup-quarantine',
  );
  makePrivateDirectory(detachedCleanupRoot);
  const detachedOperation = fs.mkdtempSync(
    path.join(detachedCleanupRoot, 'cleanup-'),
  );
  fs.chmodSync(detachedOperation, 0o700);
  const detachedResidue = path.join(detachedOperation, 'residue');
  const detachedAnchor = path.join(detachedOperation, 'anchor');
  fs.renameSync(detachedPreparation, detachedResidue);
  fs.renameSync(detached.target, detachedAnchor);
  const detachedPartial = detached.bytes.slice(0, 47);
  writeDurable(detached.target, detachedPartial);

  const recoveredDetachedPublish = reservePersistedControlPlaneRecoveryGrant(
    detached.storageRoot,
    detached.envelope,
    '2026-08-10T10:00:49.000Z',
  );
  assert.deepEqual(recoveredDetachedPublish, detached.record);
  assert.equal(fs.readFileSync(detached.target, 'utf8'), detached.bytes);
  const ambiguousTarget = fs
    .readdirSync(detachedOperation)
    .find((entry) => entry.startsWith('ambiguous-target-'));
  assert.ok(ambiguousTarget);
  assert.equal(
    fs.readFileSync(path.join(detachedOperation, ambiguousTarget), 'utf8'),
    detachedPartial,
  );

  const partial = persistenceGrantFixture();
  makePrivateDirectory(partial.directory);
  const partialPreparation = path.join(
    partial.directory,
    `.${partial.recordName}.absent.${partial.record.recordDigest.slice('sha256:'.length)}.${crypto.randomUUID()}.tmp`,
  );
  writeDurable(partialPreparation, partial.bytes.slice(0, 37));
  assert.equal(
    findPersistedControlPlaneRecoveryGrantForSource(
      partial.storageRoot,
      partial.payload.sourceControlPlaneGrantId,
    ),
    null,
    'a recognized unlinked preparation is non-authoritative until exact replay',
  );
  assert.equal(fs.existsSync(partialPreparation), true);
  const recovered = reservePersistedControlPlaneRecoveryGrant(
    partial.storageRoot,
    partial.envelope,
    partial.at,
  );
  assert.deepEqual(recovered, partial.record);
  assert.equal(
    findPersistedControlPlaneRecoveryGrantForSource(
      partial.storageRoot,
      partial.payload.sourceControlPlaneGrantId,
    )?.recordDigest,
    partial.record.recordDigest,
  );
  assert.equal(fs.existsSync(partialPreparation), false);
});

test('Recovery Grant persistence rejects and preserves unknown or unsafe residue', () => {
  for (const kind of ['unknown', 'symlink', 'hardlink'] as const) {
    const value = persistenceGrantFixture();
    makePrivateDirectory(value.directory);
    let residue: string;
    if (kind === 'unknown') {
      residue = path.join(value.directory, 'attacker.tmp');
      writeDurable(residue, 'unknown');
    } else {
      residue = path.join(
        value.directory,
        `.${value.recordName}.absent.${value.record.recordDigest.slice('sha256:'.length)}.${crypto.randomUUID()}.tmp`,
      );
      const outside = path.join(value.externalAuditRoot, `${kind}.json`);
      writeDurable(outside, value.bytes.slice(0, 31));
      if (kind === 'symlink') fs.symlinkSync(outside, residue);
      else fs.linkSync(outside, residue);
    }

    assert.throws(
      () =>
        reservePersistedControlPlaneRecoveryGrant(
          value.storageRoot,
          value.envelope,
          value.at,
        ),
      errorWithCode('HARNESS_RECOVERY_RECORD_CORRUPT'),
    );
    assert.equal(
      fs.lstatSync(residue).isFile() || fs.lstatSync(residue).isSymbolicLink(),
      true,
    );
    assert.equal(fs.existsSync(value.target), false);
  }
});

test('Recovery Grant persists a one-shot completion receipt before terminal external audit', () => {
  const value = fixture();
  const controlAudit: ControlPlaneUpdaterAuditRecord[] = [];
  const recoveryAudit: ControlPlaneRecoveryAuditRecord[] = [];
  try {
    prepareBrokenCurrentClosure(value);
    const preflight = preflightControlPlaneRecoveryRollback(
      value.storageRoot,
      value.envelope.payload.grantId,
      {
        humanSigner: 'maintainer@example.test',
        issuedAt: RECOVERY_NOW.toISOString(),
      },
      recoveryDependencies(controlAudit, recoveryAudit, RECOVERY_NOW),
    );
    const envelope: ControlPlaneRecoveryGrantEnvelope = {
      payload: preflight.payload,
      signature: 'recovery-human-signature',
    };

    assert.throws(
      () =>
        executeControlPlaneRecoveryRollback(value.storageRoot, envelope, {
          ...recoveryDependencies(controlAudit, recoveryAudit, RECOVERY_NOW),
          recoveryAuditSink: {
            append(record) {
              appendRecoveryAuditIdempotently(recoveryAudit, record);
              if (record.event === 'consumed') {
                throw new Error('simulated terminal audit outage');
              }
            },
          },
        }),
      /simulated terminal audit outage/,
    );
    const prepared = findPersistedControlPlaneRecoveryGrantForSource(
      value.storageRoot,
      value.envelope.payload.grantId,
    );
    assert.equal(prepared?.state, 'completion-pending');
    assert.ok(prepared?.receipt);
    const generationAfterRollback = readControlPlaneSupervisorState(
      value.storageRoot,
    ).generation;

    const resumed = executeControlPlaneRecoveryRollback(
      value.storageRoot,
      envelope,
      {
        ...recoveryDependencies(
          controlAudit,
          recoveryAudit,
          new Date(RECOVERY_NOW.getTime() + 1),
        ),
        recoveryAuditSink: {
          append(record) {
            appendRecoveryAuditIdempotently(recoveryAudit, record);
          },
        },
      },
    );
    assert.equal(resumed.record.state, 'consumed');
    assert.equal(resumed.effectsPerformed, false);
    assert.equal(
      readControlPlaneSupervisorState(value.storageRoot).generation,
      generationAfterRollback,
    );
    assert.deepEqual(
      recoveryAudit.map(({ event }) => event),
      ['authorized', 'rolled-back', 'consumed'],
    );
  } finally {
    value.cleanup();
  }
});

test('Recovery Grant terminalizes a failed restart probe without replaying selector effects', () => {
  const value = fixture({ oldRestartable: 'once' });
  const controlAudit: ControlPlaneUpdaterAuditRecord[] = [];
  const recoveryAudit: ControlPlaneRecoveryAuditRecord[] = [];
  try {
    prepareBrokenCurrentClosure(value);
    const preflight = preflightControlPlaneRecoveryRollback(
      value.storageRoot,
      value.envelope.payload.grantId,
      {
        humanSigner: 'maintainer@example.test',
        issuedAt: RECOVERY_NOW.toISOString(),
      },
      recoveryDependencies(controlAudit, recoveryAudit, RECOVERY_NOW),
    );
    const envelope: ControlPlaneRecoveryGrantEnvelope = {
      payload: preflight.payload,
      signature: 'recovery-human-signature',
    };

    assert.throws(
      () =>
        executeControlPlaneRecoveryRollback(
          value.storageRoot,
          envelope,
          recoveryDependencies(controlAudit, recoveryAudit, RECOVERY_NOW),
        ),
      errorWithCode('CONTROL_PLANE_PROCESS_VERIFICATION_FAILED'),
    );
    const failed = findPersistedControlPlaneRecoveryGrantForSource(
      value.storageRoot,
      value.envelope.payload.grantId,
    );
    assert.equal(failed?.state, 'failed');
    assert.equal(failed?.failure?.stage, 'restart-verification');
    assert.equal(
      failed?.failure?.errorCode,
      'CONTROL_PLANE_PROCESS_VERIFICATION_FAILED',
    );
    const generationAfterFailure = readControlPlaneSupervisorState(
      value.storageRoot,
    ).generation;
    assert.equal(generationAfterFailure, 3);
    assert.equal(
      readControlPlaneSupervisorState(value.storageRoot).activeArtifact
        .artifactId,
      value.oldArtifact.artifactId,
      'failure tombstone must preserve that the old closure was selected but not restart-verified',
    );
    assert.deepEqual(
      recoveryAudit.map(({ event }) => event),
      ['authorized', 'failed'],
    );

    assert.throws(
      () =>
        executeControlPlaneRecoveryRollback(
          value.storageRoot,
          envelope,
          recoveryDependencies(
            controlAudit,
            recoveryAudit,
            new Date(RECOVERY_NOW.getTime() + 1),
          ),
        ),
      errorWithCode('HARNESS_RECOVERY_GRANT_FAILED'),
    );
    assert.equal(
      readControlPlaneSupervisorState(value.storageRoot).generation,
      generationAfterFailure,
      'failed-grant replay must not select either closure again',
    );

    assert.throws(
      () =>
        preflightControlPlaneRecoveryRollback(
          value.storageRoot,
          value.envelope.payload.grantId,
          {
            humanSigner: 'maintainer@example.test',
            issuedAt: new Date(RECOVERY_NOW.getTime() + 2).toISOString(),
          },
          recoveryDependencies(
            controlAudit,
            recoveryAudit,
            new Date(RECOVERY_NOW.getTime() + 2),
          ),
        ),
      errorWithCode('HARNESS_RECOVERY_REPAIR_REQUIRED'),
      'a failed immutable restart bundle must release the reservation and request a distinct recovery operation',
    );
  } finally {
    value.cleanup();
  }
});

test('sealed Recovery Grant production audit forms a verifiable append-only hash chain', () => {
  const value = fixture();
  const preparationAudit: ControlPlaneUpdaterAuditRecord[] = [];
  try {
    prepareBrokenCurrentClosure(value);
    const result = captureHarness(() =>
      runHarnessBootstrapCli(
        ['control-plane', 'rollback', value.envelope.payload.grantId, '--json'],
        value.repositoryRoot,
        {
          now: () => RECOVERY_NOW,
          recoverySigner: {
            assertHumanPresent() {},
            identity: () => 'maintainer@example.test',
            sign(_payload, namespace) {
              assert.equal(namespace, HARNESS_RECOVERY_SIGNATURE_NAMESPACE);
              return 'recovery-human-signature';
            },
            verify() {},
          },
          verifyHumanSignature: recoveryDependencies(
            preparationAudit,
            [],
            RECOVERY_NOW,
          ).verifyHumanSignature,
          presentRecoverySummary() {},
        },
      ),
    );
    assert.equal(result.status, 0, result.stderr);

    const verification = verifyAuthorityAuditEvents({
      externalAuditRoot: value.externalAuditRoot,
      repositoryRoot: value.repositoryRoot,
      repositoryId: deriveAuthorityAuditRepositoryId(REPOSITORY_ID),
    });
    assert.equal(verification.ok, true);
    assert.equal(verification.recordCount, verification.projectedEventCount);
    const recoveryEvents = verification.events
      .map(({ event }) => event)
      .filter(
        (event) =>
          event.command?.name ===
          'control-plane.recovery.rollback-control-plane',
      );
    assert.deepEqual(
      recoveryEvents.map(({ eventType, result }) => ({ eventType, result })),
      [
        { eventType: 'recovery', result: 'recorded' },
        { eventType: 'rollback', result: 'rolled-back' },
        { eventType: 'grant-consume', result: 'succeeded' },
      ],
    );
  } finally {
    value.cleanup();
  }
});

function errorWithCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error &&
    'code' in error &&
    (error as Error & { code: string }).code === code;
}
