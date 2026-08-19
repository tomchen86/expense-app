import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { bootstrapInterventionStateRoot } from '../bootstrap/control-plane-trust.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { produceControlPlaneApprovalCandidateV2 } from '../src/application/control-plane/control-plane-promotion-producer.ts';
import {
  createEngineArtifact,
  createProtectedCapabilityManifest,
  protectedCapabilityClosureDigest,
  REQUIRED_PROTECTED_CAPABILITIES,
  type ProtectedCapabilityEntry,
} from '../src/modules/authority/intervention-control.ts';
import { persistInterventionPlan } from '../src/runtime/storage-journal/intervention-control-persistence.ts';
import { dispatchProductionControlPlaneUpdaterCommand } from '../src/entrypoints/cli/intervention-control-updater-cli.ts';
import {
  readControlPlaneSupervisorState,
  type ControlPlaneApprovalSummaryV2,
  type ControlPlaneApprovalSummaryV3,
} from '../src/application/control-plane/intervention-control-updater.ts';
import { persistInterventionEngineArtifact } from '../src/application/control-plane/intervention-maintenance.ts';
import {
  buildImmutableCandidateBundle,
  storeCandidateSupportingArtifacts,
  storeImmutableCandidateBundle,
  type CandidateSupportingArtifactSet,
} from '../src/modules/authority/maintainer-candidate.ts';
import {
  buildMaintainerPatchManifest,
  type CapabilityProfile,
} from '../src/modules/authority/maintainer-manifest.ts';
import type { TrustedMaintainerSigner } from '../src/modules/authority/maintainer-policy.ts';
import type { MaintainerSignerProvider } from '../src/adapters/signing/ssh/maintainer-signer.ts';
import { loadProtectedCapabilitiesFromTrustBase } from '../src/adapters/consumer/expense-app/work-registry/protected-capabilities.ts';
import { createFixtureRepository, git } from './fixture.ts';

const SOURCE_ENGINE_ROOT = path.resolve(import.meta.dirname, '..');
const FIXTURE_ORIGIN = 'https://github.com/example/fixture.git';
export const CONTROL_PLANE_FIXTURE_REPOSITORY_ID =
  'github:R_control_plane_producer_fixture';
export const CONTROL_PLANE_FIXTURE_CHANGE_ID = 'intervention-b';
const PARENT_CHANGE_ID = 'parent-a';
export const CONTROL_PLANE_FIXTURE_REVIEWER = 'fixture-reviewer';
export const CONTROL_PLANE_FIXTURE_GRANT_SIGNER = 'fixture-grant-signer';
const BOOTSTRAP_RUNTIME_NAMES = [
  'built-in-engine-closure-pin.ts',
  'canonical-json.ts',
  'control-plane-trust.ts',
] as const;
const FIXTURE_PROTECTED_CAPABILITY_LOADER_PATH =
  'src/adapters/consumer/expense-app/work-registry/protected-capabilities.ts';

export interface ControlPlaneFixtureSigning {
  trustedSigners: TrustedMaintainerSigner[];
  privateKeys: Readonly<Record<string, string>>;
  verifier: (
    payload: string,
    signature: string,
    identity: string,
    namespace: string,
  ) => boolean;
  signer: (
    identity: string,
    calls: { human: number; sign: number },
  ) => MaintainerSignerProvider;
  cleanup: () => void;
}

export interface ControlPlaneProducerFixtureOptions {
  artifactSourceDigest?: `sha256:${string}`;
  builtInEntrypointBytes?: string;
  candidateExecutableFactory?: (closureDigest: `sha256:${string}`) => Buffer;
}

export interface InitialControlPlaneBootstrapFixtureOptions {
  builtInEntrypointBytes?: string;
  now?: Date;
}

export async function setupInitialControlPlaneBootstrapFixture(
  options: InitialControlPlaneBootstrapFixtureOptions = {},
) {
  const engineRoot = createSealedEnginePackage(options.builtInEntrypointBytes);
  const signing = createSshSigningFixture();
  const repository = createRepository(engineRoot, signing.trustedSigners);
  const cleanup = () => {
    fs.rmSync(engineRoot, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
    signing.cleanup();
  };
  try {
    const gitCommonDirectory = fs.realpathSync(
      git(repository, [
        'rev-parse',
        '--path-format=absolute',
        '--git-common-dir',
      ]).trim(),
    );
    const stateRoot = bootstrapInterventionStateRoot(gitCommonDirectory);
    const initialize = await fixtureInitializer(repository);
    const initialized = initialize(
      stateRoot,
      repositoryEngineRoot(repository),
      repositoryIdentity(repository),
      options.now ?? new Date('2026-08-10T10:00:00.000Z'),
    );
    assert.equal(initialized.generation, 1);
    return {
      engineRoot,
      repository,
      stateRoot,
      initialized,
      signing,
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

export async function setupControlPlaneProducerFixture(
  options: ControlPlaneProducerFixtureOptions = {},
) {
  const engineRoot = createSealedEnginePackage(options.builtInEntrypointBytes);
  const signing = createSshSigningFixture();
  const repository = createRepository(engineRoot, signing.trustedSigners);
  const childWorkspace = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'control-plane-producer-child-')),
  );
  fs.chmodSync(childWorkspace, 0o700);
  fs.rmdirSync(childWorkspace);
  const cleanup = () => {
    fs.rmSync(engineRoot, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(childWorkspace, { recursive: true, force: true });
    signing.cleanup();
  };
  try {
    const gitCommonDirectory = fs.realpathSync(
      git(repository, [
        'rev-parse',
        '--path-format=absolute',
        '--git-common-dir',
      ]).trim(),
    );
    const stateRoot = bootstrapInterventionStateRoot(gitCommonDirectory);
    const initialize = await fixtureInitializer(repository);
    const initialized = initialize(
      stateRoot,
      repositoryEngineRoot(repository),
      repositoryIdentity(repository),
      new Date('2026-08-10T10:00:00.000Z'),
    );
    assert.equal(initialized.generation, 1);
    const beforeManifest = loadProtectedCapabilitiesFromTrustBase(
      fs.realpathSync(repository),
      'HEAD',
    );
    const frozen = freezeClassCCandidate(repository);
    persistInterventionPlan(stateRoot, {
      parent: {
        changeId: PARENT_CHANGE_ID,
        status: 'active',
        engineBinding: initialized.activeArtifact.executableDigest,
        sessionSchema: 'v4',
        blocker: null,
      },
      interventionChangeId: CONTROL_PLANE_FIXTURE_CHANGE_ID,
      checkpoint: {
        parentChangeId: PARENT_CHANGE_ID,
        baseOid: frozen.expectedOldCommit,
        worktreeFingerprint: controlPlaneFixtureDigest('producer-worktree'),
        trackedTreeDigest: controlPlaneFixtureDigest('producer-tracked-tree'),
        untrackedBundleDigest: controlPlaneFixtureDigest('producer-untracked'),
        sessionStateDigest: controlPlaneFixtureDigest('producer-session'),
        pendingIntentDigest: controlPlaneFixtureDigest('producer-intent'),
        engineDigest: initialized.activeArtifact.executableDigest,
        policyDigest: controlPlaneFixtureDigest('producer-policy'),
        createdAt: '2026-08-10T10:01:00.000Z',
      },
      childWorkspace: {
        parentWorkspacePath: fs.realpathSync(repository),
        childWorkspacePath: childWorkspace,
        changeRef: `refs/heads/work/${CONTROL_PLANE_FIXTURE_CHANGE_ID}`,
      },
      now: new Date('2026-08-10T10:01:00.000Z'),
    });
    fs.mkdirSync(childWorkspace, { mode: 0o700 });
    const candidateExecutable = path.join(childWorkspace, 'engine.mjs');
    const candidateExecutableBytes =
      options.candidateExecutableFactory?.(frozen.afterClosureDigest) ??
      controlPlaneExecutable(frozen.afterClosureDigest);
    fs.writeFileSync(candidateExecutable, candidateExecutableBytes, {
      mode: 0o755,
    });
    fs.chmodSync(candidateExecutable, 0o755);
    const candidateArtifact = createEngineArtifact({
      sourceChangeId: CONTROL_PLANE_FIXTURE_CHANGE_ID,
      sourceDigest:
        options.artifactSourceDigest ?? frozenCandidateSourceDigest(frozen),
      executableDigest: controlPlaneFixtureDigest(candidateExecutableBytes),
      protocolVersion: 3,
      canReadSessionSchemas: ['v4'],
      writesSessionSchema: 'v4',
      policySchemaVersion: 2,
      smokeReportDigest: controlPlaneFixtureDigest(
        'producer-intervention-smoke',
      ),
    });
    persistInterventionEngineArtifact(stateRoot, {
      parentChangeId: PARENT_CHANGE_ID,
      artifact: candidateArtifact,
      executablePath: candidateExecutable,
      now: new Date('2026-08-10T10:02:00.000Z'),
    });
    return {
      engineRoot,
      repository,
      childWorkspace,
      stateRoot,
      initialized,
      beforeManifest,
      frozen,
      candidateArtifact,
      signing,
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

export interface FinalizedControlPlanePromotionFixtureOptions extends ControlPlaneProducerFixtureOptions {
  reviewedAt?: string;
  grantIssuedAt?: string;
}

/**
 * Build a terminal V2 state exclusively through the production producer and
 * updater. Inputs may shape fixture material and ceremony time, but no signed
 * envelope, promotion bundle, diff, or signature can be supplied by the caller.
 */
export async function setupFinalizedControlPlanePromotionFixture(
  options: FinalizedControlPlanePromotionFixtureOptions = {},
) {
  const fixture = await setupControlPlaneProducerFixture(options);
  try {
    const reviewCalls = { present: 0, human: 0, sign: 0 };
    const grantCalls = { present: 0, human: 0, sign: 0 };
    const produced = produceControlPlaneApprovalCandidateV2(
      fs.realpathSync(fixture.repository),
      fixture.stateRoot,
      fixture.frozen.candidateBundleDigest,
      {
        now: () => new Date(options.reviewedAt ?? '2026-08-10T10:03:00.000Z'),
        reviewSigner: fixture.signing.signer(
          CONTROL_PLANE_FIXTURE_REVIEWER,
          reviewCalls,
        ),
        verifyHumanSignature: fixture.signing.verifier,
        presentReviewSummary() {
          reviewCalls.present += 1;
        },
      },
    );
    const approvalSummaries: ControlPlaneApprovalSummaryV2[] = [];
    const promoted = dispatchProductionControlPlaneUpdaterCommand(
      [
        'approve-and-apply',
        produced.candidate.candidateId,
        '--task',
        fixture.frozen.mandateBinding.mandateTaskId,
      ],
      fixture.stateRoot,
      controlPlaneFixtureUpdaterDependencies(
        fixture.frozen,
        fixture.signing.signer(CONTROL_PLANE_FIXTURE_GRANT_SIGNER, grantCalls),
        fixture.signing.verifier,
        approvalSummaries,
        new Date(options.grantIssuedAt ?? '2026-08-10T10:05:00.000Z'),
      ),
      fs.realpathSync(fixture.repository),
    );
    assert.equal(promoted.record?.kind, 'persisted-control-plane-update.v2');
    assert.equal(promoted.record.transaction.state, 'FINALIZED');
    return {
      ...fixture,
      produced,
      promoted,
      record: promoted.record,
      supervisor: promoted.supervisor,
      reviewCalls,
      grantCalls,
      approvalSummaries,
    };
  } catch (error) {
    fixture.cleanup();
    throw error;
  }
}

export function prepareSuccessorControlPlaneCandidate(
  fixture: {
    repository: string;
    stateRoot: string;
    frozen: { candidateCommit: string };
  },
  options: {
    changeId?: string;
    parentChangeId?: string;
    mandateId?: string;
    content?: string;
    commitMessage?: string;
  } = {},
) {
  const changeId = options.changeId ?? 'intervention-c';
  const parentChangeId = options.parentChangeId ?? 'parent-b';
  const repository = fs.realpathSync(fixture.repository);
  git(repository, ['reset', '--hard', fixture.frozen.candidateCommit]);
  git(repository, [
    'update-ref',
    'refs/remotes/origin/main',
    fixture.frozen.candidateCommit,
  ]);
  const frozen = freezeClassCCandidate(repository, {
    changeId,
    mandateId: options.mandateId ?? '33333333-3333-4333-8333-333333333333',
    content:
      options.content ??
      'fixture protected control-plane candidate v3 successor\n',
    commitMessage:
      options.commitMessage ?? 'Promote successor intervention engine',
  });
  const childWorkspace = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'control-plane-successor-child-')),
  );
  fs.chmodSync(childWorkspace, 0o700);
  fs.rmdirSync(childWorkspace);
  const supervisor = readControlPlaneSupervisorState(fixture.stateRoot);
  persistInterventionPlan(fixture.stateRoot, {
    parent: {
      changeId: parentChangeId,
      status: 'active',
      engineBinding: supervisor.activeArtifact.executableDigest,
      sessionSchema: 'v4',
      blocker: null,
    },
    interventionChangeId: frozen.mandateBinding.changeId,
    checkpoint: {
      parentChangeId,
      baseOid: frozen.expectedOldCommit,
      worktreeFingerprint: controlPlaneFixtureDigest('successor-worktree'),
      trackedTreeDigest: controlPlaneFixtureDigest('successor-tracked-tree'),
      untrackedBundleDigest: controlPlaneFixtureDigest('successor-untracked'),
      sessionStateDigest: controlPlaneFixtureDigest('successor-session'),
      pendingIntentDigest: controlPlaneFixtureDigest('successor-intent'),
      engineDigest: supervisor.activeArtifact.executableDigest,
      policyDigest: controlPlaneFixtureDigest('successor-policy'),
      createdAt: '2026-08-10T10:06:00.000Z',
    },
    childWorkspace: {
      parentWorkspacePath: repository,
      childWorkspacePath: childWorkspace,
      changeRef: `refs/heads/work/${frozen.mandateBinding.changeId}`,
    },
    now: new Date('2026-08-10T10:06:00.000Z'),
  });
  fs.mkdirSync(childWorkspace, { mode: 0o700 });
  const candidateExecutable = path.join(childWorkspace, 'engine.mjs');
  const candidateExecutableBytes = controlPlaneExecutable(
    frozen.afterClosureDigest,
  );
  fs.writeFileSync(candidateExecutable, candidateExecutableBytes, {
    mode: 0o755,
  });
  fs.chmodSync(candidateExecutable, 0o755);
  const candidateArtifact = createEngineArtifact({
    sourceChangeId: frozen.mandateBinding.changeId,
    sourceDigest: frozenCandidateSourceDigest(frozen),
    executableDigest: controlPlaneFixtureDigest(candidateExecutableBytes),
    protocolVersion: 3,
    canReadSessionSchemas: ['v4'],
    writesSessionSchema: 'v4',
    policySchemaVersion: 2,
    smokeReportDigest: controlPlaneFixtureDigest('successor-smoke'),
  });
  persistInterventionEngineArtifact(fixture.stateRoot, {
    parentChangeId,
    artifact: candidateArtifact,
    executablePath: candidateExecutable,
    now: new Date('2026-08-10T10:07:00.000Z'),
  });
  return {
    frozen,
    candidateArtifact,
    childWorkspace,
    cleanup() {
      fs.rmSync(childWorkspace, { recursive: true, force: true });
    },
  };
}

export function controlPlaneFixtureUpdaterDependencies(
  frozen: ReturnType<typeof freezeClassCCandidate>,
  approvalSigner: MaintainerSignerProvider,
  verifyHumanSignature: ControlPlaneFixtureSigning['verifier'],
  summaries: ControlPlaneApprovalSummaryV2[] = [],
  now = new Date('2026-08-10T10:05:00.000Z'),
) {
  const mandateBinding = {
    schemaVersion: 1 as const,
    parentTaskId: frozen.mandateBinding.mandateTaskId,
    mandateId: frozen.mandateBinding.mandateId,
    mandateDigest: frozen.mandateBinding.mandateDigest,
    changeId: frozen.mandateBinding.changeId,
    externalAuditRoot: frozen.mandateBinding.externalAuditRoot,
  };
  return {
    now: () => new Date(now.getTime()),
    consumedGrantIds: new Set<string>(),
    verifyHumanSignature,
    approvalSigner,
    presentApprovalSummaryV2(summary: ControlPlaneApprovalSummaryV2) {
      summaries.push(summary);
    },
    presentApprovalSummaryV3(_summary: ControlPlaneApprovalSummaryV3) {},
    resolveTaskMandateBinding() {
      return mandateBinding;
    },
    revalidateTaskMandateBinding(binding: typeof mandateBinding) {
      assert.deepEqual(binding, mandateBinding);
    },
    auditSink: { append() {} },
  };
}

function frozenCandidateSourceDigest(
  frozen: ReturnType<typeof freezeClassCCandidate>,
): `sha256:${string}` {
  const entries = frozen.manifest.files.map((file) => {
    if (file.operation === 'delete') {
      return { path: file.path, kind: 'deleted' as const };
    }
    assert.notEqual(file.afterMode, null);
    assert.notEqual(file.afterSha256, null);
    return {
      path: file.path,
      kind: 'file' as const,
      mode: file.afterMode!,
      contentDigest: `sha256:${file.afterSha256}` as const,
    };
  });
  return controlPlaneFixtureDigest(
    canonicalJson({
      kind: 'intervention-engine-source-snapshot.v1',
      head: frozen.expectedOldCommit,
      entries,
    }),
  );
}

function freezeClassCCandidate(
  repository: string,
  options: {
    changeId?: string;
    mandateId?: string;
    content?: string;
    commitMessage?: string;
  } = {},
) {
  const changeId = options.changeId ?? CONTROL_PLANE_FIXTURE_CHANGE_ID;
  const expectedOldCommit = git(repository, ['rev-parse', 'HEAD']).trim();
  const branch = git(repository, ['branch', '--show-current']).trim();
  const changedPath = 'protected/control-plane.update/dependency.ts';
  fs.writeFileSync(
    path.join(repository, changedPath),
    options.content ?? 'fixture protected control-plane candidate v2\n',
  );
  const afterManifest = createFixtureProtectedManifest(repository);
  const { manifestDigest: afterClosureDigest, ...manifestPayload } =
    afterManifest;
  fs.writeFileSync(
    path.join(repository, 'workflow/protected-capabilities.json'),
    `${JSON.stringify(manifestPayload, null, 2)}\n`,
  );
  const profile: CapabilityProfile = {
    id: 'control-plane-fixture',
    version: 1,
    authorityClass: 'control-plane',
    implementationPaths: [changedPath],
    evidencePaths: [],
    policyPaths: ['workflow/protected-capabilities.json'],
    verificationInfrastructurePaths: [],
    forbiddenPaths: [],
    constraints: {
      evidenceOnlyGrantForbidden: true,
      samePackageRequired: false,
      evidenceAdditionsAllowed: false,
      maximumFiles: 4,
    },
    requiredChecks: ['workflow-tests'],
    checkDependencies: {
      'workflow-tests': ['harness-engine', 'source-tree'],
    },
  };
  const manifest = buildMaintainerPatchManifest(repository, {
    profile,
    trustBaseCommit: expectedOldCommit,
    policyDigest: '1'.repeat(64),
  });
  git(repository, [
    'add',
    '--',
    changedPath,
    'workflow/protected-capabilities.json',
  ]);
  const resultTree = git(repository, ['write-tree']).trim();
  const candidateCommit = git(repository, [
    'commit-tree',
    resultTree,
    '-p',
    expectedOldCommit,
    '-m',
    options.commitMessage ?? 'Promote intervention engine',
  ]).trim();
  const rawCommit = git(repository, ['cat-file', 'commit', candidateCommit]);
  const commitMessage = rawCommit.slice(rawCommit.indexOf('\n\n') + 2);
  const mandateBinding = {
    schemaVersion: 1 as const,
    mandateTaskId: 'control-plane-promotion',
    mandateId: options.mandateId ?? '22222222-2222-4222-8222-222222222222',
    mandateDigest: '2'.repeat(64),
    changeId,
    externalAuditRoot: path.join(repository, 'external-audit'),
  };
  const artifacts: CandidateSupportingArtifactSet = {
    effectsManifest: {
      schemaVersion: 1,
      kind: 'candidate-external-effects.v1',
      changeId,
      mandateBinding,
      effects: [],
    },
    providerInvocations: {
      schemaVersion: 1,
      kind: 'candidate-provider-invocations.v1',
      changeId,
      mandateBinding,
      invocations: [],
    },
    recoveryPlan: {
      schemaVersion: 1,
      kind: 'candidate-recovery-plan.v1',
      changeId,
      mandateBinding,
      targetRef: `refs/heads/${branch}`,
      expectedOldCommit,
      expectedRefGeneration: 0,
      candidateCommit,
      rollbackTarget: expectedOldCommit,
    },
  };
  const storedArtifacts = storeCandidateSupportingArtifacts(
    fs.realpathSync(path.join(repository, '.git')),
    artifacts,
  );
  const candidate = buildImmutableCandidateBundle({
    mandateBinding,
    repositoryId: CONTROL_PLANE_FIXTURE_REPOSITORY_ID,
    targetRef: `refs/heads/${branch}`,
    expectedOldCommit,
    expectedRefGeneration: 0,
    candidateCommit,
    resultTree,
    commitMessage,
    manifest,
    checksAttestation: {
      schemaVersion: 2,
      candidateTree: resultTree,
      patchDigest: manifest.patchDigest,
      trustBaseCommit: expectedOldCommit,
      checks: [
        {
          checkId: 'workflow-tests',
          definitionDigest: '3'.repeat(64),
          commandDigest: '4'.repeat(64),
          runnerDigest: '5'.repeat(64),
          environmentDigest: '6'.repeat(64),
          resultDigest: '7'.repeat(64),
          outcome: 'passed',
          startedAt: '2026-08-10T09:58:00.000Z',
          completedAt: '2026-08-10T09:59:00.000Z',
          reuseClass: 'content-pure',
          maxAgeMs: null,
          externalSnapshotDigest: null,
          dependsOn: ['harness-engine', 'source-tree'],
        },
      ],
    },
    effectsManifestDigest: storedArtifacts.effectsManifestDigest,
    providerInvocationsDigest: storedArtifacts.providerInvocationsDigest,
    classification: 'control-plane',
    recoveryPlanDigest: storedArtifacts.recoveryPlanDigest,
    createdAt: '2026-08-10T10:00:30.000Z',
  });
  storeImmutableCandidateBundle(
    fs.realpathSync(path.join(repository, '.git')),
    candidate,
  );
  git(repository, ['reset', '--hard', expectedOldCommit]);
  return { ...candidate, afterClosureDigest, mandateBinding };
}

function createSealedEnginePackage(builtInEntrypointBytes?: string): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'control-plane-producer-engine-'),
  );
  const bootstrap = path.join(root, 'bootstrap');
  const source = path.join(root, 'src');
  fs.mkdirSync(bootstrap, { recursive: true });
  fs.mkdirSync(source, { recursive: true });
  for (const name of [
    'canonical-json.ts',
    'control-plane-trust.ts',
    'workflow-launcher.ts',
  ]) {
    fs.copyFileSync(
      path.join(SOURCE_ENGINE_ROOT, 'bootstrap', name),
      path.join(bootstrap, name),
    );
  }
  const packageBytes = `${JSON.stringify(
    { name: 'sealed-producer-engine', private: true, type: 'module' },
    null,
    2,
  )}\n`;
  const entrypointBytes =
    builtInEntrypointBytes ??
    [
      "import { BUILT_IN_ENGINE_CLOSURE_MANIFEST_DIGEST } from '../bootstrap/built-in-engine-closure-pin.ts';",
      "import { bootstrapInterventionStateRoot } from '../bootstrap/control-plane-trust.ts';",
      'void BUILT_IN_ENGINE_CLOSURE_MANIFEST_DIGEST;',
      'void bootstrapInterventionStateRoot;',
      "process.stdout.write('fixture built-in engine\\n');",
      '',
    ].join('\n');
  const protectedLoaderBytes =
    "export const fixtureProtectedCapabilitiesLoader = 'v1';\n";
  fs.writeFileSync(path.join(root, 'package.json'), packageBytes);
  fs.writeFileSync(path.join(source, 'cli.ts'), entrypointBytes);
  const protectedLoaderPath = path.join(
    root,
    FIXTURE_PROTECTED_CAPABILITY_LOADER_PATH,
  );
  fs.mkdirSync(path.dirname(protectedLoaderPath), { recursive: true });
  fs.writeFileSync(protectedLoaderPath, protectedLoaderBytes);
  const manifest = {
    kind: 'built-in-engine-closure-manifest.v1',
    entrypoint: 'src/cli.ts',
    scope: 'package-json-and-all-src-typescript',
    files: [
      {
        path: 'package.json',
        mode: '100644',
        digest: controlPlaneFixtureDigest(packageBytes),
      },
      {
        path: FIXTURE_PROTECTED_CAPABILITY_LOADER_PATH,
        mode: '100644',
        digest: controlPlaneFixtureDigest(protectedLoaderBytes),
      },
      {
        path: 'src/cli.ts',
        mode: '100644',
        digest: controlPlaneFixtureDigest(entrypointBytes),
      },
    ],
  };
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(
    path.join(bootstrap, 'built-in-engine-closure.json'),
    manifestBytes,
  );
  fs.writeFileSync(
    path.join(bootstrap, 'built-in-engine-closure-pin.ts'),
    [
      'export const BUILT_IN_ENGINE_CLOSURE_MANIFEST_DIGEST =',
      `  '${controlPlaneFixtureDigest(manifestBytes)}' as const;`,
      '',
    ].join('\n'),
  );
  return root;
}

function createRepository(
  engineRoot: string,
  trustedSigners: TrustedMaintainerSigner[],
): string {
  const repository = createFixtureRepository();
  git(repository, ['remote', 'add', 'origin', FIXTURE_ORIGIN]);
  const policy = JSON.parse(
    fs.readFileSync(
      path.resolve(SOURCE_ENGINE_ROOT, '../../workflow/maintainer-policy.json'),
      'utf8',
    ),
  ) as Record<string, unknown> & {
    repository: { id: string; origin: string };
    trustedSigners: TrustedMaintainerSigner[];
  };
  policy.repository = {
    id: CONTROL_PLANE_FIXTURE_REPOSITORY_ID,
    origin: FIXTURE_ORIGIN,
  };
  policy.trustedSigners = trustedSigners.map((signer) => ({ ...signer }));
  fs.writeFileSync(
    path.join(repository, 'workflow/maintainer-policy.json'),
    `${JSON.stringify(policy, null, 2)}\n`,
  );
  fs.cpSync(engineRoot, repositoryEngineRoot(repository), { recursive: true });
  const manifest = createFixtureProtectedManifest(repository);
  const { manifestDigest: _manifestDigest, ...manifestPayload } = manifest;
  fs.writeFileSync(
    path.join(repository, 'workflow/protected-capabilities.json'),
    `${JSON.stringify(manifestPayload, null, 2)}\n`,
  );
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'Install producer control plane']);
  git(repository, [
    'update-ref',
    'refs/remotes/origin/main',
    git(repository, ['rev-parse', 'HEAD']).trim(),
  ]);
  return repository;
}

function createFixtureProtectedManifest(repository: string) {
  const entries: ProtectedCapabilityEntry[] =
    REQUIRED_PROTECTED_CAPABILITIES.map((capability) => {
      const entrypoints = [`protected/${capability}/entry.ts`];
      const dependencies = [
        `protected/${capability}/dependency.ts`,
        ...(capability === 'adoption.journal'
          ? ['workflow/protected-capabilities.json']
          : []),
        ...(capability === 'policy.classify'
          ? [
              'packages/workflow-engine/src/adapters/consumer/expense-app/work-registry/protected-capabilities.ts',
            ]
          : []),
        ...(capability === 'control-plane.update'
          ? BOOTSTRAP_RUNTIME_NAMES.map(
              (name) => `packages/workflow-engine/bootstrap/${name}`,
            )
          : []),
      ].sort();
      for (const filePath of [...entrypoints, ...dependencies]) {
        if (filePath === 'workflow/protected-capabilities.json') continue;
        const absolute = path.join(repository, filePath);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        if (!fs.existsSync(absolute)) {
          fs.writeFileSync(absolute, `fixture protected file: ${filePath}\n`);
        }
      }
      const identities = [...new Set([...entrypoints, ...dependencies])]
        .map((filePath) =>
          filePath === 'workflow/protected-capabilities.json'
            ? {
                path: filePath,
                mode: 'manifest-self',
                objectId: 'manifest-self',
              }
            : {
                path: filePath,
                mode: '100644',
                objectId: git(repository, ['hash-object', filePath]).trim(),
              },
        )
        .sort((left, right) => left.path.localeCompare(right.path));
      const contentDigest = controlPlaneFixtureDigest(
        canonicalJson({
          kind: 'protected-capability-content.v1',
          files: identities,
        }),
      );
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
  return createProtectedCapabilityManifest({
    schemaVersion: 1,
    manifestPath: 'workflow/protected-capabilities.json',
    entries,
  });
}

function repositoryEngineRoot(repository: string): string {
  return path.join(fs.realpathSync(repository), 'packages/workflow-engine');
}

function repositoryIdentity(repository: string) {
  return {
    gitCommonDirectory: fs.realpathSync(path.join(repository, '.git')),
    worktreeRoot: fs.realpathSync(repository),
    branchRef: git(repository, ['symbolic-ref', 'HEAD']).trim(),
  };
}

type FixtureInitializer = (
  storageRoot: string,
  packageRoot: string,
  identity: ReturnType<typeof repositoryIdentity>,
  now: Date,
) => {
  generation: number;
  recordDigest: `sha256:${string}`;
  activeArtifact: {
    artifactId: `sha256:${string}`;
    executableDigest: `sha256:${string}`;
    closureDigest: `sha256:${string}`;
    executablePath: string;
  };
};

async function fixtureInitializer(
  repository: string,
): Promise<FixtureInitializer> {
  const moduleUrl = pathToFileURL(
    path.join(
      repositoryEngineRoot(repository),
      'bootstrap/control-plane-trust.ts',
    ),
  );
  moduleUrl.searchParams.set('fixture', crypto.randomUUID());
  const trust = (await import(moduleUrl.href)) as {
    initializeBuiltInControlPlaneSupervisor: FixtureInitializer;
  };
  return trust.initializeBuiltInControlPlaneSupervisor;
}

function controlPlaneExecutable(closureDigest: string): Buffer {
  return Buffer.from(`#!/usr/bin/env node
const mode = process.argv[2];
if (mode === '--control-plane-self-test') {
  process.stdout.write(JSON.stringify({kind:'control-plane-self-test.v1',healthy:true,closureDigest:'${closureDigest}'}) + '\\n');
} else if (mode === '--control-plane-restart-probe') {
  process.stdout.write(JSON.stringify({kind:'control-plane-restart.v1',ready:true,closureDigest:'${closureDigest}'}) + '\\n');
} else {
  process.exitCode = 64;
}
`);
}

function createSshSigningFixture(): ControlPlaneFixtureSigning {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'control-plane-producer-signing-')),
  );
  fs.chmodSync(root, 0o700);
  const keys = new Map(
    [CONTROL_PLANE_FIXTURE_REVIEWER, CONTROL_PLANE_FIXTURE_GRANT_SIGNER].map(
      (identity) => {
        const privateKey = path.join(root, identity);
        const generated = spawnSync(
          '/usr/bin/ssh-keygen',
          ['-q', '-t', 'ed25519', '-N', '', '-C', identity, '-f', privateKey],
          { encoding: 'utf8' },
        );
        assert.equal(generated.status, 0, generated.stderr);
        const publicKey = fs
          .readFileSync(`${privateKey}.pub`, 'utf8')
          .trim()
          .split(/\s+/)
          .slice(0, 2)
          .join(' ');
        const fingerprintResult = spawnSync(
          '/usr/bin/ssh-keygen',
          ['-l', '-E', 'sha256', '-f', `${privateKey}.pub`],
          { encoding: 'utf8' },
        );
        assert.equal(fingerprintResult.status, 0, fingerprintResult.stderr);
        const fingerprint = fingerprintResult.stdout.match(
          /SHA256:[A-Za-z0-9+/]+/,
        )?.[0];
        assert.ok(fingerprint);
        return [
          identity,
          {
            privateKey,
            trustedSigner: { identity, publicKey, fingerprint },
          },
        ] as const;
      },
    ),
  );
  const trustedSigners = [...keys.values()]
    .map(({ trustedSigner }) => ({ ...trustedSigner }))
    .sort((left, right) => left.identity.localeCompare(right.identity));
  const verifier: ControlPlaneFixtureSigning['verifier'] = (
    payload,
    signature,
    identity,
    namespace,
  ) => {
    const key = keys.get(identity);
    if (!key || namespace.length === 0) return false;
    const directory = fs.mkdtempSync(
      path.join(root, 'control-plane-producer-verify-'),
    );
    const allowedSigners = path.join(directory, 'allowed-signers');
    const signaturePath = path.join(directory, 'signature');
    try {
      fs.writeFileSync(
        allowedSigners,
        `${identity} ${key.trustedSigner.publicKey}\n`,
        { mode: 0o600 },
      );
      fs.writeFileSync(signaturePath, signature, { mode: 0o600 });
      const verified = spawnSync(
        '/usr/bin/ssh-keygen',
        [
          '-Y',
          'verify',
          '-f',
          allowedSigners,
          '-I',
          identity,
          '-n',
          namespace,
          '-s',
          signaturePath,
        ],
        { encoding: 'utf8', input: payload },
      );
      return verified.status === 0;
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
  const privateKeys = Object.freeze(
    Object.fromEntries(
      [...keys].map(([identity, value]) => [identity, value.privateKey]),
    ),
  );
  return {
    trustedSigners,
    privateKeys,
    verifier,
    signer(identity, calls): MaintainerSignerProvider {
      const key = keys.get(identity);
      assert.ok(key);
      return {
        assertHumanPresent() {
          calls.human += 1;
        },
        identity: () => identity,
        sign(payload, namespace) {
          calls.sign += 1;
          assert.ok(namespace);
          const payloadPath = path.join(root, `payload-${crypto.randomUUID()}`);
          try {
            fs.writeFileSync(payloadPath, payload, { mode: 0o600 });
            const signed = spawnSync(
              '/usr/bin/ssh-keygen',
              [
                '-Y',
                'sign',
                '-f',
                key.privateKey,
                '-n',
                namespace,
                payloadPath,
              ],
              { encoding: 'utf8' },
            );
            assert.equal(signed.status, 0, signed.stderr);
            return fs.readFileSync(`${payloadPath}.sig`, 'utf8');
          } finally {
            fs.rmSync(payloadPath, { force: true });
            fs.rmSync(`${payloadPath}.sig`, { force: true });
          }
        },
        verify(payload, signature, observedIdentity, namespace) {
          if (
            !namespace ||
            !verifier(payload, signature, observedIdentity, namespace)
          ) {
            throw new Error('invalid fixture SSH signature');
          }
        },
      };
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export function controlPlaneFixtureDigest(
  value: string | Buffer,
): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}
