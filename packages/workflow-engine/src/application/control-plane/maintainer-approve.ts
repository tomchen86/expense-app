import crypto from 'node:crypto';

import {
  deriveAuthorityAuditRepositoryId,
  scanAuthorityAuditLedger,
  type AuthorityAuditLedgerScope,
  type Sha256Digest,
} from '../../authority-audit-ledger.ts';
import {
  recordAuthorityAuditEvent,
  type AuthorityAuditServiceHooks,
} from '../../authority-audit-service.ts';
import {
  authorityRefusalDigest,
  withAuthorityRefusalAudit,
  type AuthorityRefusalAuditBinding,
} from '../../modules/authority/authority-refusal-audit.ts';
import { authorityApplicationReceiptTagRef } from '../../modules/authority/authority-application-receipt.ts';
import { pinCheckRunner, runCheck } from '../../check-runner.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import type { CheckDefinition } from '../../contracts.ts';
import {
  assertDisposableDatabase,
  createCheckEnvironment,
} from '../../database-policy.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  armPostApprovalAdmissionDeadline,
  assertPostApprovalAdmissionDeadline,
  createPostApprovalAdmissionDeadline,
  discoverRepository,
  enterPostApprovalTerminalCleanup,
  fingerprintWorkingState,
  isPostApprovalAdmissionFailure,
  runGit,
  withPostApprovalAdmissionDeadline,
  type PostApprovalAdmissionDeadline,
  type PostApprovalBudgetTestOptions,
} from '../../git.ts';
import {
  authorityCandidateCommitMessage,
  createSignedAuthorityCandidateCommitObject,
  previewExactStaging,
  resolveCommitIdentity,
  validateCommitSubject,
} from '../../git-transitions.ts';
import {
  assertStoredCandidateSupportingArtifacts,
  buildCandidateExternalEffectsManifest,
  buildImmutableCandidateBundleV2,
  ensureDurableRefGenerationLedger,
  storeCandidateHumanReadableSummary,
  storeCandidateSupportingArtifacts,
  storeImmutableCandidateBundle,
  type AnyImmutableCandidateBundle,
  type CandidateChecksAttestationV3,
  type CandidateExternalEffect,
  type CandidateProviderInvocation,
} from '../../modules/authority/maintainer-candidate.ts';
import {
  resolveCandidateHarnessEngineDigest,
  sealedCandidateDependencySnapshot,
} from './maintainer-candidate-dependencies.ts';
import {
  appendMaintainerCheckEvidence,
  completeMaintainerCheckJournal,
  openMaintainerCheckJournal,
  type MaintainerCheckJournalIdentity,
} from '../../maintainer-check-journal.ts';
import { commitAuthoritySession } from './maintainer-commit.ts';
import {
  MAINTAINER_GRANT_V2_SIGNATURE_NAMESPACE,
  canonicalMaintainerGrantV2Envelope,
  canonicalMaintainerGrantV2Payload,
  isMaintainerGrantV2Envelope,
  issueMaintainerGrantV2,
  maintainerChecksEnvironmentDigest,
  preflightMaintainerGrantV2,
  validateMaintainerEvidenceWaivers,
  type MaintainerChecksAttestation,
  type MaintainerChecksAttestationV2,
  type MaintainerEvidenceWaiver,
  type MaintainerGrantV2Envelope,
  type MaintainerGrantV2PreflightResult,
} from '../../modules/authority/maintainer-grant-v2.ts';
import { loadCapabilityProfileFromTrustBase } from '../../modules/authority/maintainer-manifest.ts';
import { parseMaintainerPolicy } from '../../modules/authority/maintainer-policy.ts';
import {
  createInteractiveSshSigner,
  type MaintainerSignerProvider,
} from '../../maintainer-signer.ts';
import { startAuthoritySession } from './maintainer-session.ts';
import {
  maintainerGrantStorePaths,
  readMaintainerGrantV2RevocationTargetUnderLifecycleLock,
  readTerminalMaintainerGrant,
  terminallyFailAvailableMaintainerGrantV2UnderLifecycleLock,
  terminallyFailMaintainerReservationUnderLifecycleLock,
  terminallyRevokeAvailableMaintainerGrantV2UnderLifecycleLock,
} from '../../maintainer-store.ts';
import { listProviderInvocationLifecycleProjections } from '../../investigation-session-store.ts';
import { loadInvestigationRuntimeContext } from '../../lifecycle-context.ts';
import { readProviderInvocation } from '../../provider-invocation-store.ts';
import {
  listConflictingActiveWorkflowSessionIds,
  withRepositoryLifecycleOperation,
} from '../../session-store.ts';
import {
  inspectActiveTaskMandateBinding,
  type TaskMandateBinding,
} from '../../modules/authority/task-mandate.ts';
import { loadStableValidatedChangeContract } from '../../validated-contract-context.ts';

export type ApproveAndApplyMaintainerGrantV2Request = {
  changeId: string;
  taskId: string;
  profileId: string;
  reason: string;
  message: string;
  externalEffects: CandidateExternalEffect[];
  evidenceWaivers?: MaintainerEvidenceWaiver[];
  ttlMinutes?: number;
};

export type ApproveAndApplyMaintainerGrantV2Options = {
  now?: Date;
  signer?: MaintainerSignerProvider;
  environment?: NodeJS.ProcessEnv;
  /** Trusted current snapshots for checks that declare external-state. */
  externalStateDigests?: Readonly<Record<string, string>>;
  commitClock?: () => Date;
  testBeforeRefUpdate?: () => void;
  testPoststateVerification?: () => void;
  commitCrashAfter?:
    'index-staged' | 'commit-created' | 'ref-cas' | 'ref-updated';
  testBeforeConsume?: () => void;
  testBeforeAudit?: (eventType: 'cas' | 'grant-consume') => void;
  testBeforeCandidateCommitSigning?: () => void;
  /** Test-only interruption point after the signed grant is durable. */
  testAfterGrantIssued?: (
    grant: ReturnType<typeof issueMaintainerGrantV2>,
  ) => void;
  /** Test-only deterministic seam; production always uses the code-owned cap. */
  testPostApprovalBudget?: PostApprovalBudgetTestOptions;
  testRefusalAuditServiceHooks?: AuthorityAuditServiceHooks;
};

export type ReissueAndApplyMaintainerGrantV2Request = {
  priorGrantId: string;
  reason: string;
  evidenceWaivers?: MaintainerEvidenceWaiver[];
  ttlMinutes?: number;
};

export type ReissueAndApplyMaintainerGrantV2Options = Omit<
  ApproveAndApplyMaintainerGrantV2Options,
  'testBeforeCandidateCommitSigning' | 'testAfterGrantIssued'
> & {
  grantId?: string;
};

export type RevokeMaintainerGrantV2Request = {
  grantId: string;
  reason: string;
};

export type RevokeMaintainerGrantV2Options = {
  now?: Date;
  signer?: MaintainerSignerProvider;
  testAfterAudit?: () => void;
  testRefusalAuditServiceHooks?: AuthorityAuditServiceHooks;
};

export type PrepareMaintainerGrantV2ChecksOptions = {
  clock?: () => Date;
  /** Trusted current snapshots for checks that declare external-state. */
  externalStateDigests?: Readonly<Record<string, string>>;
  /** Test-only interruption point after one passed check is durably journaled. */
  testAfterCheckPersisted?: (checkId: string) => void;
};

export function prepareMaintainerGrantV2Checks(
  cwd: string,
  preflight: MaintainerGrantV2PreflightResult,
  environment: NodeJS.ProcessEnv = process.env,
  options: PrepareMaintainerGrantV2ChecksOptions = {},
): MaintainerChecksAttestationV2 {
  if (!preflight.grantable || preflight.classification === 'control-plane') {
    throw workflowError(
      'MAINTAINER_CONTROL_PLANE_GRANT_REQUIRED',
      'Only an ordinary candidate can use maintainer approve-and-apply.',
      ExitCode.guard,
    );
  }
  const initial = discoverRepository(cwd);
  if (initial.head !== preflight.trustBaseCommit) {
    throw workflowError(
      'MAINTAINER_PATCH_STALE_BASE',
      'The repository base moved before pre-approval checks.',
      ExitCode.staleState,
    );
  }
  const refreshed = preflightMaintainerGrantV2(cwd, {
    profileId: preflight.manifest.profile,
  });
  if (canonicalJson(refreshed) !== canonicalJson(preflight)) {
    throw workflowError(
      'MAINTAINER_CHECK_PREFLIGHT_STALE',
      'The exact candidate no longer matches its preapproval check preflight.',
      ExitCode.staleState,
    );
  }
  const definitions = loadBaseCheckDefinitions(
    initial.repositoryRoot,
    preflight.trustBaseCommit,
    preflight.requiredChecks,
  );
  const pinned = preflight.requiredChecks.map((checkId) => ({
    checkId,
    definition: definitions[checkId]!,
    runner: pinCheckRunner(
      initial.repositoryRoot,
      checkId,
      definitions[checkId]!,
    ),
  }));
  const database = pinned.some(
    ({ definition }) => definition.destructiveDatabase,
  )
    ? assertDisposableDatabase(environment)
    : undefined;
  const fingerprint = fingerprintWorkingState(
    initial.repositoryRoot,
    initial.head,
    initial.statusEntries,
  );
  const environmentDigest = maintainerChecksEnvironmentDigest(
    database?.identity ?? null,
  );
  const basePolicy = parseMaintainerPolicy(
    JSON.parse(
      runGit(initial.repositoryRoot, [
        'show',
        `${preflight.trustBaseCommit}:workflow/maintainer-policy.json`,
      ]),
    ),
  );
  const profile = loadCapabilityProfileFromTrustBase(
    initial.repositoryRoot,
    preflight.trustBaseCommit,
    preflight.manifest.profile,
  );
  const harnessEngineDigest = resolveCandidateHarnessEngineDigest(
    initial,
    basePolicy.repository.id,
    environment,
  );
  const identity: MaintainerCheckJournalIdentity = {
    schemaVersion: 2,
    repositoryId: basePolicy.repository.id,
    repositoryRealPath: initial.repositoryRealPath,
    trustBaseCommit: preflight.trustBaseCommit,
    policyDigest: preflight.policyDigest,
    profileId: preflight.manifest.profile,
    profileVersion: preflight.manifest.profileVersion,
    patchDigest: preflight.patchDigest,
    candidateStateDigest: fingerprint,
    environmentDigest,
    harnessEngineDigest,
    requiredChecks: pinned.map((entry) => ({
      checkId: entry.checkId,
      definitionDigest: digest(canonicalJson(entry.definition)),
      runner: entry.runner.runner,
      runnerDigest: entry.runner.digest,
      destructiveDatabase: entry.definition.destructiveDatabase,
      databaseIdentity: entry.definition.destructiveDatabase
        ? (database?.identity ?? null)
        : null,
      dependsOn: [...preflight.checkDependencies[entry.checkId]!],
      externalSnapshotDigest: externalStateSnapshot(
        entry.checkId,
        preflight.checkDependencies[entry.checkId]!,
        options.externalStateDigests,
      ),
      externalMaxAgeMs: preflight.checkDependencies[entry.checkId]!.includes(
        'external-state',
      )
        ? (profile.externalStateFreshness?.[entry.checkId]?.maxAgeMs ?? null)
        : null,
    })),
  };
  const clock = options.clock ?? (() => new Date());
  const storePaths = maintainerGrantStorePaths(initial.gitCommonDirectory);
  return withRepositoryLifecycleOperation(storePaths.runtime, (assertOwned) => {
    assertOwned();
    assertCandidateUnchanged(initial.repositoryRoot, initial.head, fingerprint);
    assertHarnessEngineUnchanged(
      initial,
      basePolicy.repository.id,
      environment,
      harnessEngineDigest,
    );
    const opened = openMaintainerCheckJournal(
      initial.gitCommonDirectory,
      identity,
      clock(),
    );
    const journalPath = opened.path;
    let journal = opened.journal;
    if (journal.state === 'completed') {
      const final = journal.finalAttestation!;
      assertExactChecksAttestation(final, identity);
      return final;
    }
    for (const entry of pinned.slice(journal.checks.length)) {
      const startedAt = clock().toISOString();
      const expected = identity.requiredChecks.find(
        ({ checkId }) => checkId === entry.checkId,
      )!;
      let evidenceCompletedAt: Date | undefined;
      const evidence = runCheck(
        initial.repositoryRoot,
        entry.checkId,
        entry.definition,
        entry.runner,
        createCheckEnvironment(
          environment,
          entry.definition.destructiveDatabase,
        ),
        entry.definition.destructiveDatabase ? database?.identity : undefined,
        expected.externalSnapshotDigest
          ? {
              completedAt: () => {
                evidenceCompletedAt = clock();
                return evidenceCompletedAt;
              },
              externalSnapshotDigest: expected.externalSnapshotDigest,
              maxAgeMs: expected.externalMaxAgeMs!,
            }
          : undefined,
      );
      const completedAt = (evidenceCompletedAt ?? clock()).toISOString();
      assertCandidateUnchanged(
        initial.repositoryRoot,
        initial.head,
        fingerprint,
      );
      assertHarnessEngineUnchanged(
        initial,
        basePolicy.repository.id,
        environment,
        harnessEngineDigest,
      );
      assertOwned();
      journal = appendMaintainerCheckEvidence(
        journalPath,
        journal,
        {
          evidence,
          commandDigest: digest(canonicalJson(entry.definition)),
          startedAt,
          completedAt,
        },
        clock(),
      );
      options.testAfterCheckPersisted?.(entry.checkId);
    }
    const attestation: MaintainerChecksAttestationV2 = {
      schemaVersion: 2,
      trustBaseCommit: identity.trustBaseCommit,
      policyDigest: identity.policyDigest,
      patchDigest: identity.patchDigest,
      candidateStateDigest: identity.candidateStateDigest,
      environmentDigest: identity.environmentDigest,
      harnessEngineDigest,
      checks: journal.checks,
    };
    journal = completeMaintainerCheckJournal(
      journalPath,
      journal,
      attestation,
      clock(),
    );
    const final = journal.finalAttestation!;
    assertExactChecksAttestation(final, identity);
    return final;
  });
}

export function approveAndApplyMaintainerGrantV2(
  cwd: string,
  request: ApproveAndApplyMaintainerGrantV2Request,
  options: ApproveAndApplyMaintainerGrantV2Options = {},
) {
  const deadline = createPostApprovalAdmissionDeadline(
    options.testPostApprovalBudget,
  );
  return withPostApprovalAdmissionDeadline(deadline, () => {
    const mandateBinding = inspectActiveTaskMandateBinding(
      cwd,
      request.taskId,
      {
        now: options.now,
        signer: options.signer,
      },
    );
    const refusalBinding = applyRefusalBinding(cwd, mandateBinding, request);
    return withAuthorityRefusalAudit(
      refusalBinding,
      {
        now: options.now,
        serviceHooks: options.testRefusalAuditServiceHooks,
      },
      () =>
        approveAndApplyMaintainerGrantV2WithBinding(
          cwd,
          request,
          options,
          mandateBinding,
          deadline,
        ),
    );
  });
}

function approveAndApplyMaintainerGrantV2WithBinding(
  cwd: string,
  request: ApproveAndApplyMaintainerGrantV2Request,
  options: ApproveAndApplyMaintainerGrantV2Options,
  mandateBinding: TaskMandateBinding,
  deadline: PostApprovalAdmissionDeadline,
) {
  assertApplyMandateChange(mandateBinding, request.changeId);
  const effectsManifest = buildCandidateExternalEffectsManifest({
    changeId: request.changeId,
    mandateBinding,
    externalEffects: request.externalEffects,
  });
  const preflight = preflightMaintainerGrantV2(cwd, {
    profileId: request.profileId,
  });
  assertApproveAndApplyPreconditions(
    cwd,
    request,
    preflight,
    options.environment ?? process.env,
  );
  const frozenRepository = discoverRepository(cwd);
  const grantId = crypto.randomUUID();
  const targetRef = `refs/heads/${frozenRepository.branch!}`;
  const refLedger = ensureDurableRefGenerationLedger(
    frozenRepository.gitCommonDirectory,
    targetRef,
    frozenRepository.head,
  );
  const prospective = previewExactStaging(
    frozenRepository.repositoryRoot,
    frozenRepository.head,
    preflight.manifest.files.map(({ path: filePath }) => filePath),
  );
  const checksAttestation = prepareMaintainerGrantV2Checks(
    cwd,
    preflight,
    options.environment ?? process.env,
    { externalStateDigests: options.externalStateDigests },
  );
  // Read from the trust base, never from the candidate: a check's definition
  // is what the repository says it is, and a candidate that could restate its
  // own definition would be grading its own paper.
  const baseDefinitions = loadBaseCheckDefinitions(
    frozenRepository.repositoryRoot,
    preflight.trustBaseCommit,
    preflight.requiredChecks,
  );
  // The commit object's SSH signature is itself a human-authority ceremony.
  // Run every expensive candidate check first so a failing or ungrantable
  // candidate never asks the maintainer to unlock/sign a commit object.
  options.testBeforeCandidateCommitSigning?.();
  const candidateCommit = createSignedAuthorityCandidateCommitObject(
    frozenRepository.repositoryRoot,
    prospective.tree,
    frozenRepository.head,
    request.message,
    request.changeId,
    options.environment,
  );
  const repository = discoverRepository(cwd);
  const policy = parseMaintainerPolicy(
    JSON.parse(
      runGit(repository.repositoryRoot, [
        'show',
        `${preflight.trustBaseCommit}:workflow/maintainer-policy.json`,
      ]),
    ),
  );
  const signer =
    options.signer ??
    createInteractiveSshSigner(repository.repositoryRoot, policy);
  const auditScope = maintainerAuditScope(
    repository.repositoryRealPath,
    policy.repository.id,
    mandateBinding,
  );
  const candidateChecks = checksAttestation.checks.map((check) => {
    const dependencies = [
      ...preflight.checkDependencies[check.evidence.checkId]!,
    ];
    const externalState = dependencies.includes('external-state');
    return {
      checkId: check.evidence.checkId,
      definitionDigest: digest(
        canonicalJson(baseDefinitions[check.evidence.checkId]!),
      ),
      commandDigest: check.commandDigest,
      runnerDigest: check.evidence.runnerDigest,
      environmentDigest: checksAttestation.environmentDigest,
      resultDigest: digest(canonicalJson(check.evidence)),
      outcome: 'passed' as const,
      startedAt: check.startedAt,
      completedAt: check.completedAt,
      reuseClass: externalState
        ? ('external-state' as const)
        : ('toolchain-dependent' as const),
      maxAgeMs: externalState
        ? (check.evidence.maxAgeMs ?? null)
        : 48 * 60 * 60 * 1_000,
      externalSnapshotDigest: check.evidence.externalSnapshotDigest ?? null,
      dependsOn: dependencies,
    };
  });
  const candidateChecksAttestation: CandidateChecksAttestationV3 = {
    schemaVersion: 3,
    candidateTree: prospective.tree,
    patchDigest: preflight.patchDigest,
    trustBaseCommit: preflight.trustBaseCommit,
    dependencySnapshot: sealedCandidateDependencySnapshot({
      candidateTree: prospective.tree,
      baseCommit: preflight.trustBaseCommit,
      harnessEngineDigest: checksAttestation.harnessEngineDigest,
      policyDigest: preflight.policyDigest,
      checks: candidateChecks,
    }),
    checks: candidateChecks,
  };
  const providerInvocations = collectCandidateProviderInvocations(
    cwd,
    request.changeId,
  );
  const supportingArtifacts = storeCandidateSupportingArtifacts(
    repository.gitCommonDirectory,
    {
      effectsManifest,
      providerInvocations: {
        schemaVersion: 1,
        kind: 'candidate-provider-invocations.v1',
        changeId: request.changeId,
        mandateBinding,
        invocations: providerInvocations,
      },
      recoveryPlan: {
        schemaVersion: 1,
        kind: 'candidate-recovery-plan.v1',
        changeId: request.changeId,
        mandateBinding,
        targetRef,
        expectedOldCommit: repository.head,
        expectedRefGeneration: refLedger.generation,
        candidateCommit,
        rollbackTarget: repository.head,
      },
    },
  );
  const { bundle: candidateBundle, humanReadableSummary } =
    buildImmutableCandidateBundleV2({
      mandateBinding,
      repositoryId: policy.repository.id,
      targetRef,
      expectedOldCommit: repository.head,
      expectedRefGeneration: refLedger.generation,
      candidateCommit,
      resultTree: prospective.tree,
      commitMessage: `${authorityCandidateCommitMessage(
        request.message,
        request.changeId,
      )}\n`,
      manifest: preflight.manifest,
      checksAttestation: candidateChecksAttestation,
      effectsManifestDigest: supportingArtifacts.effectsManifestDigest,
      providerInvocationsDigest: supportingArtifacts.providerInvocationsDigest,
      classification: preflight.classification,
      recoveryPlanDigest: supportingArtifacts.recoveryPlanDigest,
      createdAt: (options.now ?? new Date()).toISOString(),
    });
  const { humanReadableSummaryDigest } = storeCandidateHumanReadableSummary(
    repository.gitCommonDirectory,
    humanReadableSummary,
  );
  if (
    humanReadableSummaryDigest !== candidateBundle.humanReadableSummaryDigest
  ) {
    throw workflowError(
      'APPLY_CANDIDATE_STORE_INVALID',
      'The candidate summary publication differs from its frozen digest.',
      ExitCode.guard,
    );
  }
  assertStoredCandidateSupportingArtifacts(
    repository.gitCommonDirectory,
    request.changeId,
    candidateBundle,
  );
  const candidateStorePath = storeImmutableCandidateBundle(
    repository.gitCommonDirectory,
    candidateBundle,
  );
  appendCandidateBundleAudit(auditScope, candidateBundle, request.changeId);
  const grant = issueMaintainerGrantV2(
    cwd,
    {
      changeId: request.changeId,
      reason: request.reason,
      manifest: preflight.manifest,
      checksAttestation,
      candidateBundle,
      evidenceWaivers: request.evidenceWaivers ?? [],
      ttlMinutes: request.ttlMinutes,
    },
    {
      now: options.now,
      grantId,
      signer,
      environment: options.environment,
      externalStateDigests: options.externalStateDigests,
      beforeGrantPublication: (envelope) => {
        armPostApprovalAdmissionDeadline(deadline);
        appendApplyGrantAudit(auditScope, envelope);
        assertPostApprovalAdmissionDeadline(deadline);
      },
    },
  );
  withPublishedGrantAdmissionCleanup(
    repository.gitCommonDirectory,
    grant.grantId,
    deadline,
    options.now,
    () => {
      assertPostApprovalAdmissionDeadline(deadline);
      options.testAfterGrantIssued?.(grant);
    },
  );
  // The one command already established human presence while signing the exact
  // candidate. Subsequent session and commit admission may reverify identity
  // and signature but must not ask the maintainer to repeat the same ceremony.
  const confirmedSigner = afterConfirmedPresence(signer);
  const session = withPublishedGrantAdmissionCleanup(
    repository.gitCommonDirectory,
    grant.grantId,
    deadline,
    options.now,
    () =>
      startAuthoritySession(cwd, request.changeId, grant.grantId, {
        now: options.now,
        signer: confirmedSigner,
        environment: options.environment,
        externalStateDigests: options.externalStateDigests,
        allowSignedV2Candidate: true,
        postApprovalDeadline: deadline,
      }),
  );
  const committed = commitAuthoritySession(
    cwd,
    session.sessionId,
    request.message,
    {
      now: options.now,
      signer: confirmedSigner,
      environment: options.environment,
      externalStateDigests: options.externalStateDigests,
      clock: options.commitClock,
      testBeforeRefUpdate: options.testBeforeRefUpdate,
      testPoststateVerification: options.testPoststateVerification,
      testCrashAfter: options.commitCrashAfter,
      testBeforeConsume: options.testBeforeConsume,
      testBeforeAudit: options.testBeforeAudit,
      postApprovalDeadline: deadline,
    },
  );
  return {
    grantId: grant.grantId,
    sessionId: session.sessionId,
    commitHash: committed.commitHash,
    attestationRelayCommand: committed.attestationRelayCommand,
    tagRef: grant.tagRef,
    publishCommand: grant.publishCommand,
    applicationReceiptTagRef: authorityApplicationReceiptTagRef(
      policy,
      grant.grantId,
    ),
    checksAttestationDigest: grant.envelope.payload.checksAttestationDigest,
    candidateCommit,
    resultTree: prospective.tree,
    candidateBundleDigest: candidateBundle.candidateBundleDigest,
    candidateStorePath,
    evidenceWaivers: grant.envelope.payload.evidenceWaivers ?? [],
    applied: true as const,
  };
}

/**
 * Re-sign and apply a retained immutable candidate after its prior one-shot
 * grant expired or was semantically invalidated before CAS. This route reads
 * the original terminal envelope and content-addressed candidate directly; it
 * does not run checks, rebuild the candidate, or create a replacement evidence
 * object.
 */
export function reissueAndApplyMaintainerGrantV2(
  cwd: string,
  request: ReissueAndApplyMaintainerGrantV2Request,
  options: ReissueAndApplyMaintainerGrantV2Options = {},
) {
  const deadline = createPostApprovalAdmissionDeadline(
    options.testPostApprovalBudget,
  );
  return withPostApprovalAdmissionDeadline(deadline, () =>
    reissueAndApplyMaintainerGrantV2WithDeadline(
      cwd,
      request,
      options,
      deadline,
    ),
  );
}

function reissueAndApplyMaintainerGrantV2WithDeadline(
  cwd: string,
  request: ReissueAndApplyMaintainerGrantV2Request,
  options: ReissueAndApplyMaintainerGrantV2Options,
  deadline: PostApprovalAdmissionDeadline,
) {
  const repository = discoverRepository(cwd);
  const prior = readTerminalMaintainerGrant(
    repository.gitCommonDirectory,
    request.priorGrantId,
  );
  if (!isMaintainerGrantV2Envelope(prior.envelope)) {
    throw workflowError(
      'MAINTAINER_GRANT_REISSUE_INVALID',
      'Only an expired or invalidated v2 grant may reissue its retained candidate.',
      ExitCode.guard,
    );
  }
  const envelope = prior.envelope;
  const trusted = verifyHistoricalApplyGrantTrust(
    repository,
    envelope,
    options.signer,
    'MAINTAINER_GRANT_REISSUE_REPOSITORY_MISMATCH',
    'Retained Apply Grant v2 no longer matches this repository identity or trust base.',
  );
  return withAuthorityRefusalAudit(
    applyGrantRefusalBinding(
      repository.repositoryRealPath,
      envelope,
      'maintainer.reissue-and-apply',
      {
        priorGrantId: request.priorGrantId,
        reasonDigest: authorityRefusalDigest(request.reason),
        ttlMinutes: request.ttlMinutes ?? null,
        requestedGrantId: options.grantId ?? null,
        evidenceWaiversDigest: authorityRefusalDigest(
          request.evidenceWaivers === undefined
            ? { declaration: 'preserve-prior' }
            : request.evidenceWaivers,
        ),
      },
    ),
    {
      now: options.now,
      serviceHooks: options.testRefusalAuditServiceHooks,
    },
    () => {
      if (!['expired', 'invalidated'].includes(prior.state)) {
        throw workflowError(
          'MAINTAINER_GRANT_REISSUE_INVALID',
          'Only an expired or invalidated v2 grant may reissue its retained candidate.',
          ExitCode.guard,
        );
      }
      const payload = envelope.payload;
      const evidenceWaivers =
        request.evidenceWaivers === undefined
          ? (payload.evidenceWaivers ?? [])
          : request.evidenceWaivers;
      const candidate = payload.candidateBundle;
      if (
        candidate === null ||
        candidate.schemaVersion !== 2 ||
        payload.checksAttestation === null ||
        payload.checksAttestation.schemaVersion !== 2
      ) {
        throw workflowError(
          'MAINTAINER_GRANT_REISSUE_INVALID',
          'The prior grant does not retain a complete immutable candidate and checks attestation.',
          ExitCode.guard,
        );
      }
      const subject = candidate.commitMessage.split('\n', 1)[0] ?? '';
      if (
        candidate.commitMessage !==
        `${authorityCandidateCommitMessage(subject, payload.changeId)}\n`
      ) {
        throw workflowError(
          'AUTHORITY_CANDIDATE_BINDING_INVALID',
          'The retained candidate does not use the grant-independent v2 commit identity.',
          ExitCode.guard,
        );
      }
      const signer = trusted.signer;
      if (signer.identity() !== payload.signer) {
        throw workflowError(
          'AUTHORITY_CANDIDATE_SIGNER_MISMATCH',
          'Candidate reissue requires the signer that created the retained candidate commit.',
          ExitCode.guard,
        );
      }
      const grant = issueMaintainerGrantV2(
        cwd,
        {
          changeId: payload.changeId,
          reason: request.reason,
          manifest: payload.manifest,
          ttlMinutes: request.ttlMinutes,
          checksAttestation: payload.checksAttestation,
          candidateBundle: candidate,
          evidenceWaivers,
        },
        {
          now: options.now,
          grantId: options.grantId,
          signer,
          environment: options.environment,
          externalStateDigests: options.externalStateDigests,
          beforeGrantPublication: (issuedEnvelope) => {
            armPostApprovalAdmissionDeadline(deadline);
            appendApplyGrantAudit(trusted.auditScope, issuedEnvelope);
            assertPostApprovalAdmissionDeadline(deadline);
          },
        },
      );
      withPublishedGrantAdmissionCleanup(
        repository.gitCommonDirectory,
        grant.grantId,
        deadline,
        options.now,
        () => assertPostApprovalAdmissionDeadline(deadline),
      );
      const confirmedSigner = afterConfirmedPresence(signer);
      const session = withPublishedGrantAdmissionCleanup(
        repository.gitCommonDirectory,
        grant.grantId,
        deadline,
        options.now,
        () =>
          startAuthoritySession(cwd, payload.changeId, grant.grantId, {
            now: options.now,
            signer: confirmedSigner,
            environment: options.environment,
            externalStateDigests: options.externalStateDigests,
            allowSignedV2Candidate: true,
            postApprovalDeadline: deadline,
          }),
      );
      const committed = commitAuthoritySession(
        cwd,
        session.sessionId,
        subject,
        {
          now: options.now,
          signer: confirmedSigner,
          environment: options.environment,
          externalStateDigests: options.externalStateDigests,
          clock: options.commitClock,
          testBeforeRefUpdate: options.testBeforeRefUpdate,
          testPoststateVerification: options.testPoststateVerification,
          testCrashAfter: options.commitCrashAfter,
          testBeforeConsume: options.testBeforeConsume,
          testBeforeAudit: options.testBeforeAudit,
          postApprovalDeadline: deadline,
        },
      );
      return {
        reissuedFromGrantId: payload.grantId,
        grantId: grant.grantId,
        sessionId: session.sessionId,
        commitHash: committed.commitHash,
        journalState: committed.journalState,
        attestationRelayCommand: committed.attestationRelayCommand,
        tagRef: grant.tagRef,
        publishCommand: grant.publishCommand,
        applicationReceiptTagRef: authorityApplicationReceiptTagRef(
          trusted.basePolicy,
          grant.grantId,
        ),
        checksAttestationDigest: grant.envelope.payload.checksAttestationDigest,
        candidateCommit: candidate.candidateCommit,
        resultTree: candidate.resultTree,
        candidateBundleDigest: candidate.candidateBundleDigest,
        evidenceWaivers: grant.envelope.payload.evidenceWaivers ?? [],
        applied: true as const,
      };
    },
  );
}

export function revokeMaintainerGrantV2(
  cwd: string,
  request: RevokeMaintainerGrantV2Request,
  options: RevokeMaintainerGrantV2Options = {},
) {
  const reason = assertApplyRevocationReason(request.reason);
  const repository = discoverRepository(cwd);
  const paths = maintainerGrantStorePaths(repository.gitCommonDirectory);
  const initial = withRepositoryLifecycleOperation(
    paths.runtime,
    (assertOwned) =>
      readMaintainerGrantV2RevocationTargetUnderLifecycleLock(
        repository.gitCommonDirectory,
        request.grantId,
        assertOwned,
      ),
    { allowMaintainerGrantId: request.grantId },
  );
  const envelope = initial.envelope;
  const trusted = verifyHistoricalApplyGrantTrust(
    repository,
    envelope,
    options.signer,
    'MAINTAINER_GRANT_REVOCATION_REPOSITORY_MISMATCH',
    'Apply Grant v2 no longer matches this repository identity or trust base.',
  );
  return withAuthorityRefusalAudit(
    applyGrantRefusalBinding(
      repository.repositoryRealPath,
      envelope,
      'maintainer.grant-v2.revoke',
      {
        grantId: request.grantId,
        reasonDigest: authorityRefusalDigest(reason),
      },
    ),
    {
      now: options.now,
      serviceHooks: options.testRefusalAuditServiceHooks,
    },
    () => {
      if (initial.state !== 'available' && initial.state !== 'revoked') {
        throw workflowError(
          'MAINTAINER_GRANT_REVOCATION_STATE_INVALID',
          'Apply Grant v2 revocation only terminalizes an available unused grant.',
          ExitCode.guard,
        );
      }
      const signer = trusted.signer;
      signer.assertHumanPresent();
      const revoker = signer.identity();
      if (
        !trusted.currentPolicy.trustedSigners.some(
          ({ identity }) => identity === revoker,
        )
      ) {
        throw workflowError(
          'MAINTAINER_GRANT_REVOCATION_SIGNER_UNTRUSTED',
          'Apply Grant v2 revocation requires a currently trusted maintainer signer.',
          ExitCode.verification,
        );
      }
      const now = exactRevocationDate(options.now ?? new Date());
      const terminalReason = `Maintainer revoke: ${reason}`;
      return withRepositoryLifecycleOperation(
        paths.runtime,
        (assertOwned) => {
          const current =
            readMaintainerGrantV2RevocationTargetUnderLifecycleLock(
              repository.gitCommonDirectory,
              request.grantId,
              assertOwned,
            );
          if (
            canonicalMaintainerGrantV2Envelope(current.envelope) !==
              canonicalMaintainerGrantV2Envelope(envelope) ||
            (current.state !== 'available' && current.state !== 'revoked') ||
            (current.state === 'revoked' &&
              current.terminalReason !== terminalReason)
          ) {
            throw workflowError(
              'MAINTAINER_GRANT_REVOCATION_STATE_INVALID',
              'Apply Grant v2 state changed before audited revocation.',
              ExitCode.staleState,
            );
          }
          const audit = appendApplyGrantRevocationAudit(
            repository.repositoryRealPath,
            current.envelope,
            revoker,
            reason,
            current.state === 'revoked'
              ? exactRevocationDate(current.terminalRecordedAt!)
              : now,
          );
          options.testAfterAudit?.();
          const grant =
            terminallyRevokeAvailableMaintainerGrantV2UnderLifecycleLock(
              repository.gitCommonDirectory,
              request.grantId,
              terminalReason,
              now,
              assertOwned,
            );
          return {
            grantId: grant.grantId,
            state: 'revoked' as const,
            taskId: current.envelope.payload.taskId,
            changeId: current.envelope.payload.changeId,
            replayed: current.state === 'revoked',
            audit,
          };
        },
        { allowMaintainerGrantId: request.grantId },
      );
    },
  );
}

function collectCandidateProviderInvocations(
  cwd: string,
  changeId: string,
): CandidateProviderInvocation[] {
  const runtime = loadInvestigationRuntimeContext(cwd).runtime;
  return listProviderInvocationLifecycleProjections(runtime)
    .filter((projection) => projection.changeId === changeId)
    .map((projection): CandidateProviderInvocation => {
      const record = readProviderInvocation(runtime, projection.invocationId);
      return {
        invocationId: projection.invocationId,
        investigationId: projection.investigationId,
        purpose: projection.purpose,
        attempt: projection.attempt,
        state: projection.state,
        requestDigest: projection.requestDigest,
        manifestDigest: projection.manifestDigest,
        outputDigest: record.result?.outputDigest ?? null,
        failureDigest:
          record.failure === null
            ? null
            : digest(canonicalJson(record.failure)),
      };
    })
    .sort((left, right) =>
      canonicalJson(left).localeCompare(canonicalJson(right)),
    );
}

function maintainerAuditScope(
  repositoryRoot: string,
  repositoryIdentity: string,
  mandateBinding: TaskMandateBinding,
): AuthorityAuditLedgerScope {
  return {
    externalAuditRoot: mandateBinding.externalAuditRoot,
    repositoryRoot,
    repositoryId: deriveAuthorityAuditRepositoryId(repositoryIdentity),
  };
}

function applyRefusalBinding(
  cwd: string,
  mandateBinding: TaskMandateBinding,
  request: ApproveAndApplyMaintainerGrantV2Request,
): AuthorityRefusalAuditBinding {
  const repository = discoverRepository(cwd);
  const policy = parseMaintainerPolicy(
    JSON.parse(
      runGit(repository.repositoryRoot, [
        'show',
        `${repository.head}:workflow/maintainer-policy.json`,
      ]),
    ),
  );
  const bindingDigest = authorityRefusalDigest(mandateBinding);
  return {
    scope: maintainerAuditScope(
      repository.repositoryRealPath,
      policy.repository.id,
      mandateBinding,
    ),
    family: 'apply',
    operation: 'maintainer.approve-and-apply',
    subjectId: `${request.changeId}:${request.taskId}`,
    actor: { kind: 'engine', identity: 'workflow-engine' },
    taskId: mandateBinding.mandateTaskId,
    changeId: mandateBinding.changeId,
    workflowId: mandateBinding.mandateId,
    grantDigest: null,
    bindingDigest,
    refusalIdentity: {
      changeId: request.changeId,
      taskId: request.taskId,
      profileId: request.profileId,
      reasonDigest: authorityRefusalDigest(request.reason),
      messageDigest: authorityRefusalDigest(request.message),
      externalEffectsDigest: authorityRefusalDigest(
        request.externalEffects === undefined
          ? { declaration: 'missing' }
          : request.externalEffects,
      ),
      evidenceWaiversDigest: authorityRefusalDigest(
        request.evidenceWaivers === undefined
          ? { declaration: 'missing' }
          : request.evidenceWaivers,
      ),
    },
  };
}

function withPublishedGrantAdmissionCleanup<T>(
  gitCommonDirectory: string,
  grantId: string,
  deadline: PostApprovalAdmissionDeadline,
  now: Date | undefined,
  operation: () => T,
): T {
  try {
    return operation();
  } catch (error) {
    if (!isPostApprovalAdmissionFailure(error)) throw error;
    enterPostApprovalTerminalCleanup(deadline);
    const reason =
      error instanceof Error
        ? error.message
        : 'Post-approval admission timed out before CAS.';
    withRepositoryLifecycleOperation(
      maintainerGrantStorePaths(gitCommonDirectory).runtime,
      (assertOwned) => {
        const current = readMaintainerGrantV2RevocationTargetUnderLifecycleLock(
          gitCommonDirectory,
          grantId,
          assertOwned,
        );
        if (current.state === 'available') {
          terminallyFailAvailableMaintainerGrantV2UnderLifecycleLock(
            gitCommonDirectory,
            grantId,
            reason,
            now ?? new Date(),
            assertOwned,
          );
        } else if (current.state === 'reserved' && current.sessionId !== null) {
          terminallyFailMaintainerReservationUnderLifecycleLock(
            gitCommonDirectory,
            grantId,
            current.sessionId,
            reason,
            now ?? new Date(),
          );
        }
      },
      { allowMaintainerGrantId: grantId },
    );
    throw error;
  }
}

function verifyHistoricalApplyGrantTrust(
  repository: ReturnType<typeof discoverRepository>,
  envelope: MaintainerGrantV2Envelope,
  providedSigner: MaintainerSignerProvider | undefined,
  repositoryMismatchCode: string,
  repositoryMismatchMessage: string,
) {
  const basePolicy = parseMaintainerPolicy(
    JSON.parse(
      runGit(repository.repositoryRoot, [
        'show',
        `${envelope.payload.baseCommit}:workflow/maintainer-policy.json`,
      ]),
    ),
  );
  const currentPolicy = parseMaintainerPolicy(
    JSON.parse(
      runGit(repository.repositoryRoot, [
        'show',
        'HEAD:workflow/maintainer-policy.json',
      ]),
    ),
  );
  const signer =
    providedSigner ??
    createInteractiveSshSigner(repository.repositoryRoot, currentPolicy);
  try {
    signer.verify(
      canonicalMaintainerGrantV2Payload(envelope.payload),
      envelope.signature,
      envelope.payload.signer,
      MAINTAINER_GRANT_V2_SIGNATURE_NAMESPACE,
    );
  } catch {
    throw workflowError(
      'AUTHORITY_SIGNATURE_INVALID',
      'Apply Grant v2 historical authority binding requires a valid original grant signature.',
      ExitCode.verification,
    );
  }
  const origin = runGit(
    repository.repositoryRoot,
    ['remote', 'get-url', 'origin'],
    true,
  ).trim();
  if (
    basePolicy.repository.id !== envelope.payload.repositoryId ||
    basePolicy.repository.origin !== envelope.payload.repositoryOrigin ||
    currentPolicy.repository.id !== envelope.payload.repositoryId ||
    currentPolicy.repository.origin !== envelope.payload.repositoryOrigin ||
    origin !== envelope.payload.repositoryOrigin ||
    !basePolicy.trustedSigners.some(
      ({ identity }) => identity === envelope.payload.signer,
    )
  ) {
    throw workflowError(
      repositoryMismatchCode,
      repositoryMismatchMessage,
      ExitCode.staleState,
    );
  }
  const auditScope = maintainerAuditScope(
    repository.repositoryRealPath,
    envelope.payload.repositoryId,
    envelope.payload.mandateBinding,
  );
  scanAuthorityAuditLedger(auditScope);
  return { auditScope, basePolicy, currentPolicy, signer };
}

function applyGrantRefusalBinding(
  repositoryRoot: string,
  envelope: MaintainerGrantV2Envelope,
  operation: string,
  refusalIdentity: Readonly<Record<string, unknown>>,
): AuthorityRefusalAuditBinding {
  const mandateBinding = envelope.payload.mandateBinding;
  return {
    scope: maintainerAuditScope(
      repositoryRoot,
      envelope.payload.repositoryId,
      mandateBinding,
    ),
    family: 'apply',
    operation,
    subjectId: envelope.payload.grantId,
    actor: { kind: 'engine', identity: 'workflow-engine' },
    taskId: mandateBinding.mandateTaskId,
    changeId: mandateBinding.changeId,
    workflowId: mandateBinding.mandateId,
    grantDigest: auditBytesDigest(canonicalMaintainerGrantV2Envelope(envelope)),
    candidateBundleDigest:
      envelope.payload.candidateBundle === null
        ? null
        : prefixedDigest(
            envelope.payload.candidateBundle.candidateBundleDigest,
          ),
    bindingDigest: authorityRefusalDigest(mandateBinding),
    refusalIdentity,
  };
}

function assertApplyMandateChange(
  binding: TaskMandateBinding,
  changeId: string,
): void {
  if (binding.changeId !== changeId) {
    throw workflowError(
      'APPLY_TASK_MANDATE_CHANGE_MISMATCH',
      'Approve-and-apply requires a Task Mandate for the exact change.',
      ExitCode.guard,
    );
  }
}

function appendCandidateBundleAudit(
  scope: AuthorityAuditLedgerScope,
  candidate: AnyImmutableCandidateBundle,
  changeId: string,
): void {
  const candidateBundleDigest = prefixedDigest(candidate.candidateBundleDigest);
  const outcomeDigest = auditValueDigest({
    kind: 'authority-candidate-artifacts.v1',
    manifestDigest: candidate.manifestDigest,
    checksAttestationDigest: candidate.checksAttestationDigest,
    effectsManifestDigest: candidate.effectsManifestDigest,
    providerInvocationsDigest: candidate.providerInvocationsDigest,
    recoveryPlanDigest: candidate.recoveryPlanDigest,
  });
  recordAuthorityAuditEvent(scope, {
    eventType: 'candidate-bundle',
    occurredAt: candidate.createdAt,
    idempotencyKey: auditValueDigest({
      kind: 'authority-candidate-bundle-audit.v1',
      candidateBundleDigest,
    }),
    grantDigest: null,
    candidateBundleDigest,
    prestateDigest: auditValueDigest({
      kind: 'authority-candidate-prestate.v1',
      targetRef: candidate.targetRef,
      expectedOldCommit: candidate.expectedOldCommit,
      expectedRefGeneration: candidate.expectedRefGeneration,
    }),
    poststateDigest: auditValueDigest({
      kind: 'authority-candidate-poststate.v1',
      candidateCommit: candidate.candidateCommit,
      resultTree: candidate.resultTree,
    }),
    actor: { kind: 'engine', identity: 'workflow-engine' },
    taskId: candidate.mandateBinding.mandateTaskId,
    changeId,
    workflowId: null,
    command: {
      name: 'candidate.freeze',
      argvDigest: auditValueDigest({ changeId, candidateBundleDigest }),
    },
    providerInvocation: null,
    externalEffect: null,
    result: 'recorded',
    outcomeDigest,
    errorCode: null,
  });
}

function appendApplyGrantAudit(
  scope: AuthorityAuditLedgerScope,
  envelope: MaintainerGrantV2Envelope,
): void {
  const canonicalEnvelope = canonicalMaintainerGrantV2Envelope(envelope);
  const candidate = envelope.payload.candidateBundle;
  if (candidate === null) {
    throw workflowError(
      'APPLY_CANDIDATE_REQUIRED',
      'Apply Grant audit requires the exact immutable candidate.',
      ExitCode.guard,
    );
  }
  const grantDigest = auditBytesDigest(canonicalEnvelope);
  const candidateBundleDigest = prefixedDigest(candidate.candidateBundleDigest);
  const outcomeDigest = auditValueDigest({
    kind: 'authority-apply-grant-result.v1',
    classification: envelope.payload.classification,
    manifestDigest: envelope.payload.manifestDigest,
    checksAttestationDigest: envelope.payload.checksAttestationDigest,
    evidenceWaivers: envelope.payload.evidenceWaivers ?? [],
  });
  recordAuthorityAuditEvent(scope, {
    eventType: 'apply-grant',
    occurredAt: envelope.payload.issuedAt,
    idempotencyKey: auditValueDigest({
      kind: 'authority-apply-grant-audit.v1',
      grantId: envelope.payload.grantId,
      grantDigest,
    }),
    grantDigest,
    candidateBundleDigest,
    prestateDigest: auditValueDigest({
      kind: 'authority-apply-grant-prestate.v1',
      baseCommit: envelope.payload.baseCommit,
      targetRef: candidate.targetRef,
      expectedRefGeneration: candidate.expectedRefGeneration,
    }),
    poststateDigest: auditValueDigest({
      kind: 'authority-signed-grant.v1',
      grantId: envelope.payload.grantId,
      expiresAt: envelope.payload.expiresAt,
      maxUses: envelope.payload.maxUses,
    }),
    actor: { kind: 'human', identity: envelope.payload.signer },
    taskId: envelope.payload.taskId,
    changeId: envelope.payload.changeId,
    workflowId: null,
    command: {
      name: 'candidate.approve-and-apply',
      argvDigest: auditValueDigest({
        changeId: envelope.payload.changeId,
        candidateBundleDigest,
      }),
    },
    providerInvocation: null,
    externalEffect: null,
    result: 'recorded',
    outcomeDigest,
    errorCode: null,
  });
}

function appendApplyGrantRevocationAudit(
  repositoryRoot: string,
  envelope: MaintainerGrantV2Envelope,
  revoker: string,
  reason: string,
  now: Date,
) {
  const binding = envelope.payload.mandateBinding;
  const scope = maintainerAuditScope(
    repositoryRoot,
    envelope.payload.repositoryId,
    binding,
  );
  const grantDigest = auditBytesDigest(
    canonicalMaintainerGrantV2Envelope(envelope),
  );
  const candidate = envelope.payload.candidateBundle;
  if (candidate === null) {
    throw workflowError(
      'APPLY_CANDIDATE_REQUIRED',
      'Apply Grant v2 revocation requires its immutable candidate.',
      ExitCode.guard,
    );
  }
  const candidateBundleDigest = prefixedDigest(candidate.candidateBundleDigest);
  const reasonDigest = auditValueDigest({
    kind: 'authority-apply-grant-revocation-reason.v1',
    reason,
  });
  const idempotencyKey = auditValueDigest({
    kind: 'authority-apply-grant-revocation.v1',
    grantId: envelope.payload.grantId,
    grantDigest,
    reasonDigest,
  });
  const durableOccurrence = scanAuthorityAuditLedger(scope).records.find(
    ({ record }) => record.idempotencyKey === idempotencyKey,
  )?.record.occurredAt;
  return recordAuthorityAuditEvent(scope, {
    eventType: 'revoke',
    occurredAt: durableOccurrence ?? now.toISOString(),
    idempotencyKey,
    grantDigest,
    candidateBundleDigest,
    prestateDigest: auditValueDigest({
      kind: 'authority-apply-grant-available.v1',
      grantId: envelope.payload.grantId,
      targetRef: candidate.targetRef,
      expectedOldCommit: candidate.expectedOldCommit,
      expectedRefGeneration: candidate.expectedRefGeneration,
    }),
    poststateDigest: auditValueDigest({
      kind: 'authority-apply-grant-revoked.v1',
      grantId: envelope.payload.grantId,
      reasonDigest,
    }),
    actor: { kind: 'human', identity: revoker },
    taskId: binding.mandateTaskId,
    changeId: binding.changeId,
    workflowId: null,
    command: {
      name: 'grant.revoke',
      argvDigest: auditValueDigest({
        grantId: envelope.payload.grantId,
        reasonDigest,
      }),
    },
    providerInvocation: null,
    externalEffect: null,
    result: 'revoked',
    outcomeDigest: auditValueDigest({
      kind: 'authority-apply-grant-revocation-result.v1',
      grantId: envelope.payload.grantId,
      reasonDigest,
    }),
    errorCode: null,
  });
}

function prefixedDigest(value: string): Sha256Digest {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw workflowError(
      'AUTHORITY_AUDIT_BINDING_INVALID',
      'Authority audit binding requires an exact SHA-256 digest.',
      ExitCode.guard,
    );
  }
  return `sha256:${value}`;
}

function auditValueDigest(value: unknown): Sha256Digest {
  return auditBytesDigest(canonicalJson(value));
}

function auditBytesDigest(value: string): Sha256Digest {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function assertApproveAndApplyPreconditions(
  cwd: string,
  request: ApproveAndApplyMaintainerGrantV2Request,
  preflight: MaintainerGrantV2PreflightResult,
  environment: NodeJS.ProcessEnv,
): void {
  validateCommitSubject(request.message);
  if (
    request.reason.length < 12 ||
    request.reason.length > 500 ||
    request.reason.trim() !== request.reason ||
    [...request.reason].some((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point <= 31 || (point >= 127 && point <= 159);
    })
  ) {
    throw workflowError(
      'MAINTAINER_GRANT_INVALID',
      'Maintainer grant reason is invalid.',
      ExitCode.guard,
    );
  }
  validateMaintainerEvidenceWaivers(
    request.evidenceWaivers ?? [],
    preflight.requiredChecks,
    preflight.checkDependencies,
  );
  const repository = discoverRepository(cwd);
  if (repository.head !== preflight.trustBaseCommit || !repository.branch) {
    throw workflowError(
      'AUTHORITY_BRANCH_INVALID',
      'Approve-and-apply requires a named branch at the exact candidate base.',
      ExitCode.staleState,
    );
  }
  const contract = loadStableValidatedChangeContract(
    repository,
    request.changeId,
  ).contract;
  const expectedBranch = contract.config.branchTemplate.replace(
    '{changeId}',
    request.changeId,
  );
  if (repository.branch !== expectedBranch) {
    throw workflowError(
      'AUTHORITY_BRANCH_INVALID',
      `Approve-and-apply requires branch ${expectedBranch}.`,
      ExitCode.staleState,
    );
  }
  const activeSessions = listConflictingActiveWorkflowSessionIds(
    maintainerGrantStorePaths(repository.gitCommonDirectory).runtime,
    {
      changeId: request.changeId,
      repositoryRoot: repository.repositoryRealPath,
      targetRef: `refs/heads/${repository.branch}`,
    },
  );
  if (activeSessions.length > 0) {
    throw workflowError(
      'ACTIVE_SESSION_CONFLICT',
      'Maintainer approve-and-apply conflicts with an active change, workspace, or target ref.',
      ExitCode.conflict,
      { details: { activeSessionIds: activeSessions } },
    );
  }
  const signingFormat = runGit(
    repository.repositoryRoot,
    ['config', '--local', '--get', 'gpg.format'],
    true,
  ).trim();
  const signingKey = runGit(
    repository.repositoryRoot,
    ['config', '--local', '--get', 'user.signingkey'],
    true,
  ).trim();
  if (signingFormat !== 'ssh' || !signingKey) {
    throw workflowError(
      'AUTHORITY_GIT_SIGNING_REQUIRED',
      'Approve-and-apply requires local SSH commit signing configuration before checks or grant signing.',
      ExitCode.unsafeEnvironment,
    );
  }
  resolveCommitIdentity(repository.repositoryRoot, environment);
}

function assertCandidateUnchanged(
  repositoryRoot: string,
  head: string,
  expectedFingerprint: string,
): void {
  const current = discoverRepository(repositoryRoot);
  if (
    current.head !== head ||
    fingerprintWorkingState(
      current.repositoryRoot,
      current.head,
      current.statusEntries,
    ) !== expectedFingerprint
  ) {
    throw workflowError(
      'AUTHORITY_CHECK_MUTATED_WORKTREE',
      'A pre-approval check changed the immutable candidate.',
      ExitCode.staleState,
    );
  }
}

function externalStateSnapshot(
  checkId: string,
  dependencies: readonly string[],
  snapshots: Readonly<Record<string, string>> | undefined,
): string | null {
  if (!dependencies.includes('external-state')) return null;
  const snapshot = snapshots?.[checkId];
  if (typeof snapshot !== 'string' || !/^[0-9a-f]{64}$/.test(snapshot)) {
    throw workflowError(
      'APPLY_ATTESTATION_EXTERNAL_STATE_REQUIRED',
      `Check ${checkId} requires a trusted current external-state snapshot.`,
      ExitCode.staleState,
    );
  }
  return snapshot;
}

function assertHarnessEngineUnchanged(
  repository: ReturnType<typeof discoverRepository>,
  repositoryId: string,
  environment: NodeJS.ProcessEnv,
  expectedDigest: string,
): void {
  if (
    resolveCandidateHarnessEngineDigest(
      repository,
      repositoryId,
      environment,
    ) !== expectedDigest
  ) {
    throw workflowError(
      'APPLY_ATTESTATION_INVALIDATED',
      'The selected harness engine changed while candidate checks were running.',
      ExitCode.staleState,
    );
  }
}

function assertExactChecksAttestation(
  attestation: MaintainerChecksAttestation,
  identity: MaintainerCheckJournalIdentity,
): asserts attestation is MaintainerChecksAttestationV2 {
  if (
    identity.schemaVersion !== 2 ||
    attestation.schemaVersion !== 2 ||
    attestation.trustBaseCommit !== identity.trustBaseCommit ||
    attestation.policyDigest !== identity.policyDigest ||
    attestation.patchDigest !== identity.patchDigest ||
    attestation.candidateStateDigest !== identity.candidateStateDigest ||
    attestation.environmentDigest !== identity.environmentDigest ||
    attestation.harnessEngineDigest !== identity.harnessEngineDigest ||
    attestation.checks.length !== identity.requiredChecks.length ||
    attestation.checks.some((check, index) => {
      const expected = identity.requiredChecks[index];
      return (
        !expected ||
        check.evidence.checkId !== expected.checkId ||
        check.evidence.runnerDigest !== expected.runnerDigest ||
        check.commandDigest !== expected.definitionDigest
      );
    })
  ) {
    throw workflowError(
      'MAINTAINER_CHECK_JOURNAL_INVALID',
      'The terminal check journal does not match its exact execution identity.',
      ExitCode.staleState,
    );
  }
}

function loadBaseCheckDefinitions(
  repositoryRoot: string,
  baseCommit: string,
  requiredChecks: string[],
): Record<string, CheckDefinition> {
  try {
    const raw = JSON.parse(
      runGit(repositoryRoot, ['show', `${baseCommit}:workflow/checks.json`]),
    ) as { schemaVersion?: unknown; checks?: unknown };
    if (
      raw.schemaVersion !== 1 ||
      typeof raw.checks !== 'object' ||
      raw.checks === null ||
      Array.isArray(raw.checks)
    ) {
      throw new Error('invalid base checks');
    }
    const checks = raw.checks as Record<string, unknown>;
    return Object.fromEntries(
      requiredChecks.map((checkId) => {
        const definition = checks[checkId] as
          Partial<CheckDefinition> | undefined;
        if (
          !definition ||
          !Array.isArray(definition.command) ||
          !definition.command.every((part) => typeof part === 'string') ||
          typeof definition.destructiveDatabase !== 'boolean'
        ) {
          throw new Error(`invalid base check ${checkId}`);
        }
        return [
          checkId,
          {
            command: [...definition.command],
            destructiveDatabase: definition.destructiveDatabase,
          },
        ];
      }),
    );
  } catch {
    throw workflowError(
      'AUTHORITY_CHECK_INVALID',
      'Required check definitions are unavailable from the exact grant base.',
      ExitCode.guard,
    );
  }
}

function afterConfirmedPresence(
  signer: MaintainerSignerProvider,
): MaintainerSignerProvider {
  return {
    assertHumanPresent() {},
    identity: () => signer.identity(),
    sign: (payload, namespace) => signer.sign(payload, namespace),
    verify: (payload, signature, identity, namespace) =>
      signer.verify(payload, signature, identity, namespace),
  };
}

function assertApplyRevocationReason(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 12 ||
    value.length > 500 ||
    value.trim() !== value ||
    [...value].some((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point <= 31 || (point >= 127 && point <= 159);
    })
  ) {
    throw workflowError(
      'MAINTAINER_GRANT_REVOCATION_REASON_INVALID',
      'Apply Grant v2 revocation requires an exact human-readable reason.',
      ExitCode.guard,
    );
  }
  return value;
}

function exactRevocationDate(value: Date | string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw workflowError(
      'MAINTAINER_GRANT_REVOCATION_TIME_INVALID',
      'Apply Grant v2 revocation requires an exact timestamp.',
      ExitCode.guard,
    );
  }
  return date;
}

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
