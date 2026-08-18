import crypto from 'node:crypto';

import { loadAiAdapterPolicy } from './ai-adapter-policy.ts';
import { canonicalJson } from './canonical-json.ts';
import {
  compareAndSwapEvidenceRefsDocument,
  investigationEvidenceRefsClosureDigest,
  quarantineUnsafeEvidenceRefsDocument,
  readInvestigationEvidenceRefsClosure,
} from './evidence-object-store.ts';
import { ExitCode, workflowError } from './errors.ts';
import {
  createReplacementAttempt,
  providerExecutionEnvironmentDigest,
  providerExecutionPolicySnapshot,
  type RetryMode,
} from './execution-core.ts';
import {
  loadProviderExecutionRepairContext,
  preflightProviderRepairRetry,
} from './provider-execution-governance.ts';
import { runGit } from './git.ts';
import { copyGrantDate } from './grant-primitives.ts';
import {
  assertHumanResolutionDecision,
  assertInvestigationCheckpointEnvelope,
  compareAndSwapCurrentInvestigationRef,
  compareAndSwapHumanResolutionHead,
  checkpointContributionDigest,
  checkpointEnvelopeDigest,
  compareAndSwapInvestigationSession,
  createInvestigationHumanActionBlocker,
  createHumanResolutionJournal,
  createHumanResolutionNode,
  createCurrentInvestigationRef,
  createInvestigationId,
  createInvestigationSessionRecord,
  deriveInvestigationSessionState,
  inspectInvestigationResolutionState,
  inspectInvestigationQuarantineState,
  inspectInterruptedHumanResolutionGrantPublications,
  investigationCurrentRefDigest,
  investigationCheckpointId,
  investigationResolutionStateDigest,
  humanResolutionDecisionSchemaDigest,
  investigationSessionExists,
  inspectStoredHumanResolutionGrants,
  scanProviderInvocationLifecycles,
  quarantineUnsafeCurrentInvestigationRef,
  quarantineUnsafeInvestigationStartReservation,
  quarantineInterruptedHumanResolutionGrantPublication,
  quarantineUnsafeHumanResolutionRef,
  readCurrentInvestigationRef,
  readHumanResolutionArchive,
  readHumanResolutionHead,
  readHumanResolutionJournal,
  readHumanResolutionNode,
  readInvestigationSession,
  archiveHumanResolutionSingleton,
  revokeStoredHumanResolutionGrant,
  withHumanResolutionGrantExecution,
  writeHumanResolutionArchive,
  writeHumanResolutionJournal,
  writeHumanResolutionNode,
  writeHumanResolutionReceipt,
  type GroupDispositionsPayload,
  type HumanResolutionGrantPublicationAuditTag,
  type HumanResolutionGrantPublicationStateBinding,
  type HumanResolutionGrantPublicationStoreState,
  type QuarantinedHumanResolutionGrantPublication,
  type HumanResolutionConsequences,
  type HumanResolutionDecision,
  type HumanResolutionExpectedState,
  type HumanResolutionJournal,
  type HumanResolutionGrantStoreEntry,
  type HumanResolutionNode,
  type HumanResolutionTarget,
  type InvestigationCheckpointEnvelope,
  type InvestigationCheckpointKind,
  type InvestigationResolutionState,
  type InvestigationSession,
  type InvestigationSessionState,
  type MainTermsPayload,
  type StoredInvestigationCheckpoint,
  type WhyAnswersPayload,
} from './investigation-session-store.ts';
import { loadInvestigationRuntimeContext } from './lifecycle-context.ts';
import {
  assertResolutionConsequences,
  assertResolutionDecisionAvailable,
  assertResolutionDecisionTarget,
  humanResolutionBlockerBinding,
  loadMaintainerPolicyForResolution,
  parseHumanResolutionGrantEnvelope,
  verifyHumanResolutionGrantForRevocation,
} from './maintainer-grant.ts';
import type { HumanRevocationOptions } from './human-revocation.ts';
import { IMPLEMENTATION_RECONCILIATION_POLICY_DIGEST } from './implementation-reconciliation-policy.ts';
import { GLOBAL_PLAN_REVIEW_COVERAGE_POLICY_DIGEST } from './plan-review-coverage.ts';
import { assertChangeId, assertInvestigationId } from './paths.ts';
import {
  assertHeldChangeTransitionAuthority,
  type HeldChangeTransitionAuthority,
  withGrantHumanResolutionTransitionAuthority,
  withHumanResolutionTransitionAuthority,
  withInvestigationTransitionAuthority,
} from './planning-lock.ts';
import type { ProviderInvocationRequest } from './provider-contracts.ts';
import {
  assertProviderWorkersQuiescentUnderLifecycleLock,
  blindSurveyIntentDigest,
  blindSurveyManifestDigest,
  createInvestigationStartReservation,
  createProviderInvocation,
  createProviderRetryReservation,
  ensureProviderExecutionPolicySnapshot,
  ensureProviderExecutionPolicySnapshotFromSnapshot,
  expireProviderInvocationLeaseUnderLifecycleLock,
  providerInvocationExists,
  readBlindSurveyManifest,
  readInvestigationStartReservation,
  readInvestigationStartReservationSnapshot,
  readProviderInvocation,
  readProviderInvocationRequest,
  readProviderRetryReservation,
  retireInvestigationStartReservation,
  type BlindSurveyManifest,
  type InvestigationStartReservation,
  type ProviderInvocationFailure,
  type ProviderInvocationRecord,
} from './provider-invocation-store.ts';
import {
  assertProviderExecutionGrantAuthorization,
  authorizeAutomaticProviderRetry,
  type ProviderExecutionGrantAuthorization,
} from './provider-retry-decision.ts';
import {
  assertActiveTaskMandateBindingUnderLifecycleLock,
  authorizeTaskMandateProviderReservationUnderLifecycleLock,
  type TaskMandateBinding,
} from './task-mandate.ts';

export type InvestigationStatus = {
  kind: 'investigation';
  investigationId: string;
  changeId: string;
  revision: number;
  semanticRevision: number;
  lifecycleRevision: number;
  state: InvestigationSessionState;
  baseline: {
    head: string;
    tree: string;
  };
  intentDigest: string;
  blindManifestDigest: string;
  providerInvocationId: string;
  provider: {
    state: ProviderInvocationRecord['state'];
    providerId: ProviderInvocationRecord['providerId'];
    attempt: number;
    revision: number;
    leaseGeneration: number;
    leaseExpiresAt: string | null;
    failure: ProviderInvocationFailure | null;
    resultDigest: string | null;
  };
  checkpoint: {
    schemaVersion: 1;
    kind: InvestigationCheckpointKind;
    checkpointId: string;
  } | null;
  nextAction:
    | 'submit-main-terms'
    | 'wait-for-provider'
    | 'resume-provider-result'
    | 'expire-provider-lease'
    | 'retry-provider'
    | 'reconcile-repository'
    | 'submit-group-dispositions'
    | 'submit-why-answers'
    | 'resolve-actor'
    | 'human-action'
    | 'investigation-complete';
};

export type StartInvestigationSessionInput = {
  changeId: string;
  blindManifest: BlindSurveyManifest;
  blindRequest: ProviderInvocationRequest;
  mandateBinding?: TaskMandateBinding;
};

export type RetryInvestigationProviderInput = {
  expectedRevision: number;
  replacementRequest: ProviderInvocationRequest;
  executionGrantAuthorization?: ProviderExecutionGrantAuthorization;
};

export type HumanResolutionExecutionOptions = {
  now?: Date;
  simulateCrashAfter?:
    | 'prepared'
    | 'evidence-refs'
    | 'start-reservation'
    | 'current-ref'
    | 'state-published'
    | 'receipt-written'
    | 'completed';
};

export class SimulatedHumanResolutionCrash extends Error {
  readonly phase: NonNullable<
    HumanResolutionExecutionOptions['simulateCrashAfter']
  >;

  constructor(
    phase: NonNullable<HumanResolutionExecutionOptions['simulateCrashAfter']>,
  ) {
    super(`Simulated human-resolution crash after ${phase}.`);
    this.phase = phase;
  }
}

export type HumanResolutionExecutionResult = {
  grantId: string;
  investigationId: string;
  decision: HumanResolutionNode['decision'];
  beforeStateDigest: string;
  afterStateDigest: string;
  resolutionNodeId: string;
  receiptDigest: string;
  recovered: boolean;
};

export type GrantCoreHumanResolutionAuthorization = Readonly<{
  schemaVersion: 1;
  kind: 'grant-core-human-resolution.v1';
  challengeId: string;
  approvalSubjectDigest: `sha256:${string}`;
  repositoryId: string;
  repositoryHead: string;
  repositoryTree: string;
  target: HumanResolutionTarget;
  expected: HumanResolutionExpectedState;
  decision: HumanResolutionDecision;
  consequences: HumanResolutionConsequences;
}>;

type HumanResolutionExecutionAuthorization = Readonly<{
  grantId: string;
  grantDigest: string;
  repositoryId: string;
  repositoryHead: string;
  repositoryTree: string | null;
  target: HumanResolutionTarget;
  expected: HumanResolutionExpectedState;
  decision: HumanResolutionDecision;
  consequences: HumanResolutionConsequences;
}>;

export type HumanResolutionGrantInspection = {
  grantId: string;
  state: HumanResolutionGrantStoreEntry['state'];
  investigationId: string;
  changeId: string;
  expectedStateDigest: string;
  decision: HumanResolutionNode['decision'];
  consequences: HumanResolutionNode['consequences'];
  issuedAt: string;
  expiresAt: string;
  signer: string;
  terminalReason: string | null;
  recordedAt: string | null;
};

export type HumanResolutionGrantPublicationRecoveryInspection =
  HumanResolutionGrantPublicationStoreState & {
    auditTag: HumanResolutionGrantPublicationAuditTag;
    publicationStateDigest: string;
  };

export function inspectHumanResolutionGrants(
  cwd: string,
  requestedGrantId?: string,
): HumanResolutionGrantInspection[] {
  const context = loadInvestigationRuntimeContext(cwd);
  return inspectStoredHumanResolutionGrants(
    context.runtime,
    requestedGrantId,
  ).map(inspectHumanResolutionGrant);
}

export function inspectHumanResolutionGrantPublicationRecoveries(
  cwd: string,
  requestedGrantId?: string,
): HumanResolutionGrantPublicationRecoveryInspection[] {
  const context = loadInvestigationRuntimeContext(cwd);
  return inspectInterruptedHumanResolutionGrantPublications(
    context.runtime,
    requestedGrantId,
  ).map(({ storeState, preparedBinding }) =>
    inspectHumanResolutionGrantPublicationRecovery(
      context,
      storeState,
      preparedBinding,
    ),
  );
}

export function discardHumanResolutionGrantPublication(
  cwd: string,
  requestedGrantId: string,
  expectedPublicationStateDigest: string,
  reason: string,
  now: Date = new Date(),
): QuarantinedHumanResolutionGrantPublication {
  const context = loadInvestigationRuntimeContext(cwd);
  return withHumanResolutionGrantExecution(
    context.runtime,
    requestedGrantId,
    () =>
      quarantineInterruptedHumanResolutionGrantPublication(
        context.runtime,
        requestedGrantId,
        expectedPublicationStateDigest,
        reason,
        (storeState) => {
          const { auditTag, publicationStateDigest } =
            inspectHumanResolutionGrantPublicationRecovery(
              context,
              storeState,
              null,
            );
          return { auditTag, publicationStateDigest };
        },
        now,
      ),
    { allowPublicationRecovery: true },
  );
}

function inspectHumanResolutionGrantPublicationRecovery(
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  storeState: HumanResolutionGrantPublicationStoreState,
  preparedBinding: HumanResolutionGrantPublicationStateBinding | null,
): HumanResolutionGrantPublicationRecoveryInspection {
  if (preparedBinding !== null) {
    const publicationStateDigest = digest(
      canonicalJson({
        schemaVersion: 1,
        kind: 'human-resolution-grant-publication-state',
        ...storeState,
        auditTag: preparedBinding.auditTag,
      }),
    );
    if (publicationStateDigest !== preparedBinding.publicationStateDigest) {
      throw workflowError(
        'HUMAN_RESOLUTION_GRANT_PUBLICATION_RECOVERY_STALE',
        'Prepared publication recovery no longer matches its bound state.',
        ExitCode.staleState,
      );
    }
    return {
      ...storeState,
      auditTag: preparedBinding.auditTag,
      publicationStateDigest,
    };
  }
  const tagSuffix = `/resolution-${storeState.grantId}`;
  const matchingTags = runGit(context.git.repositoryRoot, [
    'for-each-ref',
    '--format=%(refname)%09%(objectname)%09%(objecttype)',
    'refs/tags',
  ])
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t'))
    .filter(([ref]) => ref?.endsWith(tagSuffix));
  if (matchingTags.length > 1) {
    throw workflowError(
      'HUMAN_RESOLUTION_GRANT_PUBLICATION_RECOVERY_AMBIGUOUS',
      'Multiple local audit tags could belong to the interrupted grant publication.',
      ExitCode.unsafeEnvironment,
    );
  }
  const [tagRef = null, refObjectOid = null, objectType = null] =
    matchingTags[0] ?? [];
  if (
    refObjectOid !== null &&
    (tagRef === null ||
      objectType !== 'tag' ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(refObjectOid))
  ) {
    throw workflowError(
      'HUMAN_RESOLUTION_GRANT_PUBLICATION_RECOVERY_AMBIGUOUS',
      'The local audit ref is not an exact annotated tag.',
      ExitCode.unsafeEnvironment,
    );
  }
  const auditTag = {
    status: refObjectOid ? ('present' as const) : ('absent' as const),
    tagRef,
    refObjectOid,
    objectType,
  };
  const publicationStateDigest = digest(
    canonicalJson({
      schemaVersion: 1,
      kind: 'human-resolution-grant-publication-state',
      ...storeState,
      auditTag,
    }),
  );
  return {
    ...storeState,
    auditTag,
    publicationStateDigest,
  };
}

export function revokeHumanResolutionGrant(
  cwd: string,
  requestedGrantId: string,
  options?: HumanRevocationOptions,
): HumanResolutionGrantInspection {
  if (options === undefined) {
    throw workflowError(
      'HUMAN_REVOCATION_API_REQUIRED',
      'Human-resolution revocation requires an exact reason and current-human authorization.',
      ExitCode.guard,
    );
  }
  const context = loadInvestigationRuntimeContext(cwd);
  return withHumanResolutionGrantExecution(
    context.runtime,
    requestedGrantId,
    () => {
      const stored = inspectStoredHumanResolutionGrants(
        context.runtime,
        requestedGrantId,
      )[0]!;
      const envelope = parseHumanResolutionGrantEnvelope(stored.envelopeBytes);
      verifyHumanResolutionGrantForRevocation(
        context.git.repositoryRoot,
        envelope,
        options.verifier,
      );
      if (stored.state === 'revoked') {
        return inspectHumanResolutionGrant(
          revokeStoredHumanResolutionGrant(
            context.runtime,
            context.git.repositoryRoot,
            requestedGrantId,
            options,
          ),
        );
      }
      if (stored.state === 'consumed') {
        throw workflowError(
          'HUMAN_REVOCATION_STATE_INVALID',
          'Consumed human-resolution authority cannot be revoked.',
          ExitCode.guard,
        );
      }
      const current = inspectHumanResolutionGrant(stored);
      return withHumanResolutionTransitionAuthority(
        context.lifecycleRuntime,
        current.changeId,
        requestedGrantId,
        (assertOwned) => {
          assertOwned();
          const revoked = revokeStoredHumanResolutionGrant(
            context.runtime,
            context.git.repositoryRoot,
            requestedGrantId,
            options,
          );
          assertOwned();
          return inspectHumanResolutionGrant(revoked);
        },
      );
    },
  );
}

function inspectHumanResolutionGrant(
  entry: HumanResolutionGrantStoreEntry,
): HumanResolutionGrantInspection {
  const envelope = parseHumanResolutionGrantEnvelope(entry.envelopeBytes);
  if (envelope.payload.grantId !== entry.grantId) {
    throw workflowError(
      'HUMAN_RESOLUTION_GRANT_UNSAFE',
      'Human resolution grant storage and envelope identities differ.',
      ExitCode.unsafeEnvironment,
    );
  }
  return {
    grantId: entry.grantId,
    state: entry.state,
    investigationId: envelope.payload.target.workflowId,
    changeId: envelope.payload.target.changeId,
    expectedStateDigest: envelope.payload.expected.stateDigest,
    decision: envelope.payload.decision,
    consequences: envelope.payload.consequences,
    issuedAt: envelope.payload.issuedAt,
    expiresAt: envelope.payload.expiresAt,
    signer: envelope.payload.signer,
    terminalReason: entry.terminalReason,
    recordedAt: entry.recordedAt,
  };
}

export function executeHumanResolutionGrant(
  _cwd: string,
  _requestedGrantId: string,
  _options: HumanResolutionExecutionOptions = {},
): HumanResolutionExecutionResult {
  throw workflowError(
    'LEGACY_GRANT_V1_LIVE_TRANSITION_DISABLED',
    'Legacy V1 human-resolution grants are historical read-only evidence and cannot start a new live transition.',
    ExitCode.guard,
  );
}

export function recoverHumanResolutionGrant(
  _cwd: string,
  _requestedGrantId: string,
  _options: Omit<HumanResolutionExecutionOptions, 'simulateCrashAfter'> = {},
): HumanResolutionExecutionResult {
  throw workflowError(
    'LEGACY_GRANT_V1_LIVE_TRANSITION_DISABLED',
    'Legacy V1 human-resolution grants are historical read-only evidence and cannot recover a live transition.',
    ExitCode.guard,
  );
}

export type GrantCoreHumanResolutionExecutionOptions = Readonly<{
  now?: Date;
  simulateCrashAfter?: NonNullable<
    HumanResolutionExecutionOptions['simulateCrashAfter']
  >;
}>;

export function executeGrantCoreHumanResolution(
  cwd: string,
  input: GrantCoreHumanResolutionAuthorization,
  assertRepositoryLifecycleOwned: () => void,
  options: GrantCoreHumanResolutionExecutionOptions = {},
): HumanResolutionExecutionResult {
  const context = loadInvestigationRuntimeContext(cwd);
  const authorization = grantCoreHumanResolutionAuthorization(input);
  if (
    context.git.head !== authorization.repositoryHead ||
    context.git.tree !== authorization.repositoryTree
  ) {
    throw workflowError(
      'GRANT_STATE_CHANGED',
      'Repository state changed after the human decision; fresh approval is required.',
      ExitCode.staleState,
    );
  }
  const { policy } = loadMaintainerPolicyForResolution(
    context.git.repositoryRoot,
    authorization.repositoryHead,
  );
  const origin = runGit(context.git.repositoryRoot, [
    'remote',
    'get-url',
    'origin',
  ]).trim();
  if (
    policy.repository.id !== authorization.repositoryId ||
    origin !== policy.repository.origin
  ) {
    throw workflowError(
      'HUMAN_RESOLUTION_REPOSITORY_MISMATCH',
      'The Grant Core resolution belongs to another repository.',
      ExitCode.guard,
    );
  }

  return withGrantHumanResolutionTransitionAuthority(
    context.lifecycleRuntime,
    authorization.target.changeId,
    authorization.grantId,
    assertRepositoryLifecycleOwned,
    (authority) => {
      const assertOwned = assertHeldChangeTransitionAuthority(
        authority,
        authorization.target.changeId,
      );
      assertOwned();
      const existing = readHumanResolutionJournal(
        context.runtime,
        authorization.grantId,
      );
      let prepared: PreparedHumanResolutionExecution;
      let recovered: boolean;
      if (existing === null) {
        const state = inspectAuthorizedHumanResolutionState(
          context,
          authorization,
        );
        assertGrantCoreHumanResolutionState(context, authorization, state);
        assertHumanResolutionProviderQuiescence(
          context,
          authorization.target.workflowId,
        );
        assertOwned();
        prepared = prepareAuthorizedHumanResolutionExecution(
          context,
          authorization,
          state,
          options,
          exactHumanResolutionDate(options.now ?? new Date()),
        );
        recovered = false;
      } else {
        if (
          existing.grantDigest !== authorization.grantDigest ||
          canonicalJson(existing.target) !== canonicalJson(authorization.target)
        ) {
          throw humanResolutionRecoveryAmbiguous();
        }
        const node = readHumanResolutionNodeForRecovery(
          context.runtime,
          existing,
        );
        const beforeState = readHumanResolutionArchive(
          context.runtime,
          existing.evidenceArchiveDigest,
        );
        prepared = {
          authorization,
          node,
          journal: existing,
          receipt: buildHumanResolutionReceipt(
            authorization,
            existing,
            node,
            existing.afterStateDigest,
          ),
          beforeState,
        };
        recovered = true;
      }
      assertOwned();
      const result = publishHumanResolutionExecution(
        cwd,
        context,
        prepared,
        options,
        recovered,
      );
      assertOwned();
      return result;
    },
  );
}

function grantCoreHumanResolutionAuthorization(
  input: GrantCoreHumanResolutionAuthorization,
): HumanResolutionExecutionAuthorization {
  const keys = Object.keys(input as object).sort();
  const expectedKeys = [
    'approvalSubjectDigest',
    'challengeId',
    'consequences',
    'decision',
    'expected',
    'kind',
    'repositoryHead',
    'repositoryId',
    'repositoryTree',
    'schemaVersion',
    'target',
  ].sort();
  if (
    keys.length !== expectedKeys.length ||
    !keys.every((key, index) => key === expectedKeys[index]) ||
    input.schemaVersion !== 1 ||
    input.kind !== 'grant-core-human-resolution.v1' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      input.challengeId,
    ) ||
    !/^sha256:[0-9a-f]{64}$/.test(input.approvalSubjectDigest) ||
    typeof input.repositoryId !== 'string' ||
    input.repositoryId.trim() !== input.repositoryId ||
    input.repositoryId.length < 1 ||
    Buffer.byteLength(input.repositoryId) > 1_024 ||
    !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(input.repositoryHead) ||
    !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(input.repositoryTree) ||
    input.target.workflowKind !== 'investigation' ||
    assertChangeId(input.target.changeId) !== input.target.changeId ||
    assertInvestigationId(input.target.workflowId) !==
      input.target.workflowId ||
    !/^[0-9a-f]{64}$/.test(input.expected.stateDigest) ||
    (input.expected.currentRefDigest !== null &&
      !/^[0-9a-f]{64}$/.test(input.expected.currentRefDigest)) ||
    typeof input.expected.reasonCode !== 'string' ||
    typeof input.expected.blockedTransition !== 'string'
  ) {
    throw workflowError(
      'GRANT_CORE_HUMAN_RESOLUTION_INVALID',
      'Grant Core human-resolution authorization is malformed.',
      ExitCode.guard,
    );
  }
  const decision = assertHumanResolutionDecision(input.decision);
  assertResolutionConsequences(decision, input.consequences);
  const normalized = JSON.parse(
    canonicalJson({ ...input, decision }),
  ) as GrantCoreHumanResolutionAuthorization;
  return {
    grantId: normalized.challengeId,
    grantDigest: digest(
      canonicalJson({
        schema: 'grant-core-human-resolution-authorization.v1',
        authorization: normalized,
      }),
    ),
    repositoryId: normalized.repositoryId,
    repositoryHead: normalized.repositoryHead,
    repositoryTree: normalized.repositoryTree,
    target: normalized.target,
    expected: normalized.expected,
    decision: normalized.decision,
    consequences: normalized.consequences,
  };
}

function inspectAuthorizedHumanResolutionState(
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  authorization: HumanResolutionExecutionAuthorization,
): InvestigationResolutionState {
  return authorization.decision.kind === 'quarantine'
    ? inspectInvestigationQuarantineState(
        context.runtime,
        authorization.target.workflowId,
        authorization.repositoryId,
      )
    : inspectInvestigationResolutionState(
        context.runtime,
        authorization.target.workflowId,
        authorization.repositoryId,
      );
}

function assertGrantCoreHumanResolutionState(
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  authorization: HumanResolutionExecutionAuthorization,
  state: InvestigationResolutionState,
): void {
  const blocker = humanResolutionBlockerBinding(state);
  if (
    state.envelope.repositoryId !== authorization.repositoryId ||
    state.envelope.changeId !== authorization.target.changeId ||
    state.envelope.investigationId !== authorization.target.workflowId ||
    state.currentStateDigest !== authorization.expected.stateDigest ||
    state.currentRefDigest !== authorization.expected.currentRefDigest ||
    blocker.reasonCode !== authorization.expected.reasonCode ||
    blocker.blockedTransition !== authorization.expected.blockedTransition
  ) {
    throw workflowError(
      'GRANT_STATE_CHANGED',
      'Investigation state changed after the human decision; fresh approval is required.',
      ExitCode.staleState,
    );
  }
  assertResolutionDecisionAvailable(state, authorization.decision);
  assertResolutionDecisionTarget(
    context.runtime,
    state,
    authorization.decision,
  );
  const advertised = state.availableResolutions.find(
    ({ kind }) => kind === authorization.decision.kind,
  );
  if (
    advertised?.parameterSchemaDigest !==
    humanResolutionDecisionSchemaDigest(authorization.decision.kind)
  ) {
    throw workflowError(
      'GRANT_TRANSITION_DEFINITION_CHANGED',
      'Investigation resolution schema changed after challenge creation.',
      ExitCode.staleState,
    );
  }
}

type PreparedHumanResolutionExecution = {
  authorization: HumanResolutionExecutionAuthorization;
  node: HumanResolutionNode;
  journal: HumanResolutionJournal;
  receipt: Record<string, unknown>;
  beforeState: InvestigationResolutionState;
};

function prepareAuthorizedHumanResolutionExecution(
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  authorization: HumanResolutionExecutionAuthorization,
  state: InvestigationResolutionState,
  options: HumanResolutionExecutionOptions,
  now: Date,
): PreparedHumanResolutionExecution {
  let currentRef: ReturnType<typeof readCurrentInvestigationRef>;
  try {
    currentRef = readCurrentInvestigationRef(
      context.runtime,
      authorization.target.changeId,
    );
  } catch (error) {
    if (
      authorization.decision.kind !== 'quarantine' ||
      state.envelope.ambiguityDigest === null ||
      state.currentRefDigest === null
    ) {
      throw error;
    }
    currentRef = null;
  }
  const plannedCurrentWorkflowRef = planHumanResolutionCurrentRef(
    authorization,
    currentRef?.investigationId ?? null,
  );
  const plannedStartReservation = planHumanResolutionStartReservation(
    context,
    authorization,
    state,
  );
  const plannedEvidenceRefs = planHumanResolutionEvidenceRefs(
    context,
    authorization,
    state,
  );
  let previousResolutionNodeId: string | null;
  let resolutionRefMode: HumanResolutionJournal['resolutionRefMode'] =
    'preserve';
  try {
    previousResolutionNodeId = readHumanResolutionHead(
      context.runtime,
      authorization.target.workflowId,
    );
  } catch (error) {
    if (
      authorization.decision.kind !== 'quarantine' ||
      state.envelope.ambiguityDigest === null
    ) {
      throw error;
    }
    previousResolutionNodeId = state.envelope.resolutionHeadNodeId;
    resolutionRefMode = 'quarantine-whole';
  }
  if (previousResolutionNodeId !== state.envelope.resolutionHeadNodeId) {
    throw workflowError(
      'HUMAN_RESOLUTION_GRANT_STALE',
      'Human resolution overlay changed during preparation.',
      ExitCode.staleState,
    );
  }
  const node = createHumanResolutionNode({
    target: authorization.target,
    expected: authorization.expected,
    decision: authorization.decision,
    consequences: authorization.consequences,
    grantId: authorization.grantId,
    grantDigest: authorization.grantDigest,
    previousResolutionNodeId,
    createdAt: now.toISOString(),
  });
  const evidenceArchiveDigest = writeHumanResolutionArchive(
    context.runtime,
    state.currentStateDigest,
    state,
  );
  writeHumanResolutionNode(context.runtime, node);
  const afterEnvelope = {
    ...state.envelope,
    currentRefDigest: plannedCurrentWorkflowRef.nextDigest,
    startReservationDigest: plannedStartReservation.nextDigest,
    evidenceRefs:
      plannedEvidenceRefs.nextDigest === null
        ? null
        : plannedEvidenceRefs.retainedRefs,
    evidenceRefsDigest: plannedEvidenceRefs.nextDigest,
    evidenceRefsClosureDigest: plannedEvidenceRefs.nextClosureDigest,
    resolutionHeadNodeId: node.nodeId,
  };
  const afterStateDigest = investigationResolutionStateDigest(afterEnvelope);
  const provisionalJournal = {
    phase: 'prepared' as const,
    grantId: authorization.grantId,
    grantDigest: authorization.grantDigest,
    target: authorization.target,
    beforeStateDigest: state.currentStateDigest,
    afterStateDigest,
    beforeResolutionRef: previousResolutionNodeId,
    resolutionRefMode,
    plannedResolutionNodeId: node.nodeId,
    plannedCurrentWorkflowRef,
    plannedStartReservation,
    plannedEvidenceRefs,
    evidenceArchiveDigest,
    receiptDigest: '0'.repeat(64),
    createdAt: now.toISOString(),
  };
  const provisional = createHumanResolutionJournal(provisionalJournal);
  const receipt = buildHumanResolutionReceipt(
    authorization,
    provisional,
    node,
    afterStateDigest,
  );
  const receiptDigest = digest(canonicalJson(receipt));
  const journal = createHumanResolutionJournal({
    ...provisionalJournal,
    receiptDigest,
  });
  writeHumanResolutionJournal(context.runtime, journal);
  maybeSimulateHumanResolutionCrash(options, 'prepared');
  return { authorization, node, journal, receipt, beforeState: state };
}

function publishHumanResolutionExecution(
  cwd: string,
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  prepared: PreparedHumanResolutionExecution,
  options: HumanResolutionExecutionOptions,
  recovered: boolean,
): HumanResolutionExecutionResult {
  const { authorization, node, journal, receipt, beforeState } = prepared;
  if (
    node.nodeId !== journal.plannedResolutionNodeId ||
    digest(canonicalJson(receipt)) !== journal.receiptDigest ||
    beforeState.currentStateDigest !== journal.beforeStateDigest
  ) {
    throw humanResolutionRecoveryAmbiguous();
  }
  quarantineUnsafeResolutionRefIfNeeded(
    context,
    journal,
    node,
    beforeState,
    authorization.repositoryId,
  );
  assertRecoverableStateShape(
    context,
    beforeState,
    journal,
    authorization.repositoryId,
  );
  publishPlannedEvidenceRefs(context, journal);
  publishHumanResolutionJournalPhase(
    context,
    journal,
    'evidence-refs-published',
  );
  maybeSimulateHumanResolutionCrash(options, 'evidence-refs');
  publishPlannedStartReservation(context, journal);
  publishHumanResolutionJournalPhase(
    context,
    journal,
    'start-reservation-published',
  );
  maybeSimulateHumanResolutionCrash(options, 'start-reservation');
  publishPlannedCurrentInvestigationRef(context, journal, node, beforeState);
  publishHumanResolutionJournalPhase(context, journal, 'current-ref-published');
  maybeSimulateHumanResolutionCrash(options, 'current-ref');
  const observedHead = readHumanResolutionHead(
    context.runtime,
    journal.target.workflowId,
  );
  const expectedHead =
    journal.resolutionRefMode === 'quarantine-whole'
      ? null
      : journal.beforeResolutionRef;
  if (observedHead === expectedHead) {
    compareAndSwapHumanResolutionHead(
      context.runtime,
      journal.target.workflowId,
      expectedHead,
      journal.plannedResolutionNodeId,
    );
  } else if (observedHead !== journal.plannedResolutionNodeId) {
    throw humanResolutionRecoveryAmbiguous();
  }
  const afterState =
    node.decision.kind === 'quarantine'
      ? inspectInvestigationQuarantineState(
          context.runtime,
          journal.target.workflowId,
          authorization.repositoryId,
        )
      : inspectInvestigationResolutionState(
          context.runtime,
          journal.target.workflowId,
          authorization.repositoryId,
        );
  if (afterState.currentStateDigest !== journal.afterStateDigest) {
    throw humanResolutionRecoveryAmbiguous();
  }
  publishHumanResolutionJournalPhase(context, journal, 'state-published');
  maybeSimulateHumanResolutionCrash(options, 'state-published');
  const receiptDigest = writeHumanResolutionReceipt(
    context.runtime,
    authorization.grantId,
    receipt,
  );
  if (receiptDigest !== journal.receiptDigest) {
    throw humanResolutionRecoveryAmbiguous();
  }
  publishHumanResolutionJournalPhase(context, journal, 'receipt-written');
  maybeSimulateHumanResolutionCrash(options, 'receipt-written');
  writeHumanResolutionJournal(
    context.runtime,
    updateHumanResolutionJournalPhase(journal, 'completed'),
  );
  maybeSimulateHumanResolutionCrash(options, 'completed');
  return {
    grantId: authorization.grantId,
    investigationId: journal.target.workflowId,
    decision: node.decision,
    beforeStateDigest: journal.beforeStateDigest,
    afterStateDigest: journal.afterStateDigest,
    resolutionNodeId: node.nodeId,
    receiptDigest,
    recovered,
  };
}

function quarantineUnsafeResolutionRefIfNeeded(
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  journal: HumanResolutionJournal,
  node: HumanResolutionNode,
  beforeState: InvestigationResolutionState,
  repositoryId: string,
): void {
  if (
    node.decision.kind !== 'quarantine' ||
    beforeState.envelope.ambiguityDigest === null ||
    journal.resolutionRefMode !== 'quarantine-whole'
  ) {
    return;
  }
  quarantineUnsafeHumanResolutionRef(
    context.runtime,
    journal.target.workflowId,
    repositoryId,
    beforeState.currentStateDigest,
  );
}

function assertHumanResolutionProviderQuiescence(
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  investigationId: string,
): void {
  readInvestigationSession(context.runtime, investigationId);
  try {
    assertProviderWorkersQuiescentUnderLifecycleLock(context.runtime);
  } catch {
    throw workflowError(
      'HUMAN_RESOLUTION_PROVIDER_NOT_QUIESCENT',
      'Human resolution requires every repository provider worker to be durably quiescent.',
      ExitCode.guard,
    );
  }
  let projections: ReturnType<
    typeof scanProviderInvocationLifecycles
  >['projections'];
  try {
    projections = scanProviderInvocationLifecycles(context.runtime).projections;
  } catch {
    throw workflowError(
      'HUMAN_RESOLUTION_PROVIDER_NOT_QUIESCENT',
      'Human resolution requires every repository provider invocation to have a safe, unleased lifecycle state.',
      ExitCode.guard,
    );
  }
  for (const invocation of projections) {
    if (invocation.state === 'leased' || invocation.lease !== null) {
      throw workflowError(
        'HUMAN_RESOLUTION_PROVIDER_NOT_QUIESCENT',
        'Human resolution requires every repository provider invocation to be unleased and quiescent.',
        ExitCode.guard,
        {
          details: {
            invocationId: invocation.invocationId,
            investigationId: invocation.investigationId,
            state: invocation.state,
          },
        },
      );
    }
  }
}

function planHumanResolutionCurrentRef(
  authorization: HumanResolutionExecutionAuthorization,
  observedInvestigationId: string | null,
): HumanResolutionJournal['plannedCurrentWorkflowRef'] {
  const targetId = authorization.target.workflowId;
  const decision = authorization.decision;
  let nextInvestigationId = observedInvestigationId;
  if (decision.kind === 'abort' || decision.kind === 'quarantine') {
    if (observedInvestigationId === targetId) {
      nextInvestigationId = null;
    }
  } else if (decision.kind === 'supersede') {
    if (
      decision.parameters.successorInvestigationId !== null &&
      observedInvestigationId !== targetId
    ) {
      throw workflowError(
        'HUMAN_RESOLUTION_CURRENT_REF_MISMATCH',
        'A superseding successor can replace only the exact current target.',
        ExitCode.staleState,
      );
    }
    nextInvestigationId =
      observedInvestigationId === targetId
        ? decision.parameters.successorInvestigationId
        : observedInvestigationId;
  } else if (decision.kind === 'repair') {
    if (observedInvestigationId !== targetId) {
      throw workflowError(
        'HUMAN_RESOLUTION_CURRENT_REF_MISMATCH',
        'Typed current-ref repair requires the bound target to be current.',
        ExitCode.staleState,
      );
    }
    nextInvestigationId = decision.parameters.successorInvestigationId;
  } else if (observedInvestigationId !== targetId) {
    throw workflowError(
      'HUMAN_RESOLUTION_CURRENT_REF_MISMATCH',
      'A progressing resolution requires the bound investigation to be current.',
      ExitCode.staleState,
    );
  }
  return {
    expectedInvestigationId: observedInvestigationId,
    expectedDigest: investigationCurrentRefDigest(
      observedInvestigationId === null
        ? null
        : {
            changeId: authorization.target.changeId,
            investigationId: observedInvestigationId,
          },
    ),
    nextInvestigationId,
    nextDigest: investigationCurrentRefDigest(
      nextInvestigationId === null
        ? null
        : {
            changeId: authorization.target.changeId,
            investigationId: nextInvestigationId,
          },
    ),
  };
}

function releasesGenerationNamespace(
  decision: HumanResolutionNode['decision'],
): boolean {
  return (
    decision.kind === 'abort' ||
    decision.kind === 'quarantine' ||
    (decision.kind === 'supersede' &&
      decision.parameters.successorInvestigationId === null)
  );
}

function planHumanResolutionStartReservation(
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  authorization: HumanResolutionExecutionAuthorization,
  state: InvestigationResolutionState,
): HumanResolutionJournal['plannedStartReservation'] {
  const decision = authorization.decision;
  if (
    (decision.kind === 'repair' ||
      (decision.kind === 'supersede' &&
        decision.parameters.successorInvestigationId !== null)) &&
    decision.parameters.successorInvestigationId !== null
  ) {
    throw workflowError(
      'HUMAN_RESOLUTION_SUCCESSOR_BINDING_MISSING',
      'A successor resolution requires a complete versioned start and evidence binding.',
      ExitCode.guard,
    );
  }
  let snapshot: ReturnType<typeof readInvestigationStartReservationSnapshot>;
  try {
    snapshot = readInvestigationStartReservationSnapshot(
      context.runtime,
      authorization.target.changeId,
    );
  } catch (error) {
    if (
      decision.kind !== 'quarantine' ||
      state.envelope.ambiguityDigest === null ||
      state.envelope.startReservationDigest === null
    ) {
      throw error;
    }
    return {
      mode: 'quarantine-whole',
      expectedDigest: state.envelope.startReservationDigest,
      nextDigest: null,
      archiveDigest: state.envelope.startReservationDigest,
    };
  }
  if (snapshot.digest !== state.envelope.startReservationDigest) {
    throw workflowError(
      'HUMAN_RESOLUTION_GRANT_STALE',
      'Investigation start reservation changed after grant issuance.',
      ExitCode.staleState,
    );
  }
  if (!releasesGenerationNamespace(decision) || snapshot.digest === null) {
    return {
      mode: 'preserve',
      expectedDigest: snapshot.digest,
      nextDigest: snapshot.digest,
      archiveDigest: null,
    };
  }
  if (
    snapshot.reservation?.changeId !== authorization.target.changeId ||
    snapshot.reservation.investigationId !== authorization.target.workflowId ||
    snapshot.rawDocument === null
  ) {
    throw humanResolutionRecoveryAmbiguous();
  }
  archiveHumanResolutionSingleton(
    context.runtime,
    'start-reservation',
    snapshot.digest,
    snapshot.rawDocument,
    true,
  );
  return {
    mode: 'retire',
    expectedDigest: snapshot.digest,
    nextDigest: null,
    archiveDigest: snapshot.digest,
  };
}

function planHumanResolutionEvidenceRefs(
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  authorization: HumanResolutionExecutionAuthorization,
  state: InvestigationResolutionState,
): HumanResolutionJournal['plannedEvidenceRefs'] {
  const quarantineWhole =
    (): HumanResolutionJournal['plannedEvidenceRefs'] => ({
      mode: 'quarantine-whole',
      expectedDigest: state.envelope.evidenceRefsDigest,
      nextDigest: null,
      expectedClosureDigest: state.envelope.evidenceRefsClosureDigest,
      nextClosureDigest: null,
      retiredRefs: {},
      retainedRefs: {},
      archiveDigest: state.envelope.evidenceRefsDigest,
    });
  if (
    authorization.decision.kind === 'quarantine' &&
    state.envelope.ambiguityDigest !== null &&
    state.envelope.evidenceRefs === null &&
    state.envelope.evidenceRefsDigest !== null &&
    state.envelope.evidenceRefsClosureDigest === null
  ) {
    return quarantineWhole();
  }
  let closure: ReturnType<typeof readInvestigationEvidenceRefsClosure>;
  try {
    closure = readInvestigationEvidenceRefsClosure(
      context.runtime,
      authorization.target.changeId,
    );
  } catch (error) {
    if (
      authorization.decision.kind !== 'quarantine' ||
      state.envelope.ambiguityDigest === null ||
      state.envelope.evidenceRefsDigest === null
    ) {
      throw error;
    }
    return quarantineWhole();
  }
  const snapshot = closure.snapshot;
  if (
    snapshot.digest !== state.envelope.evidenceRefsDigest ||
    canonicalJson(snapshot.refs) !==
      canonicalJson(state.envelope.evidenceRefs) ||
    closure.closureDigest !== state.envelope.evidenceRefsClosureDigest
  ) {
    throw workflowError(
      'HUMAN_RESOLUTION_GRANT_STALE',
      'Investigation evidence refs changed after grant issuance.',
      ExitCode.staleState,
    );
  }
  const currentRefs = { ...(snapshot.refs ?? {}) };
  if (!releasesGenerationNamespace(authorization.decision)) {
    return {
      mode: 'preserve',
      expectedDigest: snapshot.digest,
      nextDigest: snapshot.digest,
      expectedClosureDigest: closure.closureDigest,
      nextClosureDigest: closure.closureDigest,
      retiredRefs: {},
      retainedRefs: currentRefs,
      archiveDigest: null,
    };
  }
  const retiredRefs: Record<string, string> = {};
  const retainedRefs: Record<string, string> = {};
  for (const [refName, nodeId] of Object.entries(currentRefs)) {
    const owner = closure.owners[refName];
    if (owner === undefined) {
      throw humanResolutionRecoveryAmbiguous();
    }
    if (owner === authorization.target.workflowId) {
      retiredRefs[refName] = nodeId;
    } else {
      retainedRefs[refName] = nodeId;
    }
  }
  if (Object.keys(retiredRefs).length === 0) {
    return {
      mode: 'preserve',
      expectedDigest: snapshot.digest,
      nextDigest: snapshot.digest,
      expectedClosureDigest: closure.closureDigest,
      nextClosureDigest: closure.closureDigest,
      retiredRefs: {},
      retainedRefs,
      archiveDigest: null,
    };
  }
  if (snapshot.digest === null || snapshot.rawDocument === null) {
    throw humanResolutionRecoveryAmbiguous();
  }
  archiveHumanResolutionSingleton(
    context.runtime,
    'evidence-refs',
    snapshot.digest,
    snapshot.rawDocument,
    false,
  );
  const nextDigest =
    Object.keys(retainedRefs).length === 0
      ? null
      : digest(
          canonicalJson({
            schemaVersion: 1,
            changeId: authorization.target.changeId,
            refs: retainedRefs,
          }),
        );
  const nextClosureDigest =
    Object.keys(retainedRefs).length === 0
      ? null
      : investigationEvidenceRefsClosureDigest(
          authorization.target.changeId,
          closure.entries.filter((entry) =>
            Object.hasOwn(retainedRefs, entry.refName),
          ),
        );
  return {
    mode: 'partition',
    expectedDigest: snapshot.digest,
    nextDigest,
    expectedClosureDigest: closure.closureDigest,
    nextClosureDigest,
    retiredRefs,
    retainedRefs,
    archiveDigest: snapshot.digest,
  };
}

function publishPlannedEvidenceRefs(
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  journal: HumanResolutionJournal,
): void {
  const planned = journal.plannedEvidenceRefs;
  if (planned.mode === 'quarantine-whole') {
    quarantineUnsafeEvidenceRefsDocument(
      context.runtime,
      journal.target.changeId,
      planned.expectedDigest as string,
    );
    return;
  }
  const nextRefs = planned.nextDigest === null ? null : planned.retainedRefs;
  const published = compareAndSwapEvidenceRefsDocument(context.runtime, {
    changeId: journal.target.changeId,
    expectedDigest: planned.expectedDigest,
    nextRefs,
  });
  if (published.digest !== planned.nextDigest) {
    throw humanResolutionRecoveryAmbiguous();
  }
  const closure = readInvestigationEvidenceRefsClosure(
    context.runtime,
    journal.target.changeId,
  );
  if (
    closure.snapshot.digest !== planned.nextDigest ||
    closure.closureDigest !== planned.nextClosureDigest ||
    canonicalJson(closure.snapshot.refs) !== canonicalJson(nextRefs)
  ) {
    throw humanResolutionRecoveryAmbiguous();
  }
}

function publishPlannedStartReservation(
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  journal: HumanResolutionJournal,
): void {
  const planned = journal.plannedStartReservation;
  if (planned.mode === 'quarantine-whole') {
    quarantineUnsafeInvestigationStartReservation(
      context.runtime,
      journal.target.changeId,
      planned.expectedDigest as string,
    );
    return;
  }
  if (planned.mode === 'retire') {
    const published = retireInvestigationStartReservation(context.runtime, {
      changeId: journal.target.changeId,
      expectedDigest: planned.expectedDigest,
    });
    if (published.digest !== planned.nextDigest) {
      throw humanResolutionRecoveryAmbiguous();
    }
    return;
  }
  const observed = readInvestigationStartReservationSnapshot(
    context.runtime,
    journal.target.changeId,
  );
  if (
    observed.digest !== planned.expectedDigest ||
    observed.digest !== planned.nextDigest
  ) {
    throw humanResolutionRecoveryAmbiguous();
  }
}

function publishPlannedCurrentInvestigationRef(
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  journal: HumanResolutionJournal,
  node: HumanResolutionNode,
  beforeState: InvestigationResolutionState,
): void {
  let observed: string | null;
  try {
    observed =
      readCurrentInvestigationRef(context.runtime, journal.target.changeId)
        ?.investigationId ?? null;
  } catch (error) {
    if (
      node.decision.kind !== 'quarantine' ||
      beforeState.envelope.ambiguityDigest === null ||
      beforeState.currentRefDigest === null
    ) {
      throw error;
    }
    quarantineUnsafeCurrentInvestigationRef(
      context.runtime,
      journal.target.changeId,
      beforeState.currentRefDigest,
    );
    observed = null;
  }
  const expected = journal.plannedCurrentWorkflowRef.expectedInvestigationId;
  const next = journal.plannedCurrentWorkflowRef.nextInvestigationId;
  if (observed === next) {
    return;
  }
  if (observed !== expected) {
    throw humanResolutionRecoveryAmbiguous();
  }
  if (expected !== next) {
    compareAndSwapCurrentInvestigationRef(
      context.runtime,
      journal.target.changeId,
      expected,
      next,
    );
  }
}

function assertRecoverableStateShape(
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  before: InvestigationResolutionState,
  journal: HumanResolutionJournal,
  repositoryId: string,
): void {
  const node = readHumanResolutionNode(
    context.runtime,
    journal.plannedResolutionNodeId,
  );
  const observed =
    node.decision.kind === 'quarantine'
      ? inspectInvestigationQuarantineState(
          context.runtime,
          journal.target.workflowId,
          repositoryId,
        )
      : inspectInvestigationResolutionState(
          context.runtime,
          journal.target.workflowId,
          repositoryId,
        );
  const stableObserved = {
    ...observed.envelope,
    currentRefDigest: before.envelope.currentRefDigest,
    startReservationDigest: before.envelope.startReservationDigest,
    evidenceRefs: before.envelope.evidenceRefs,
    evidenceRefsDigest: before.envelope.evidenceRefsDigest,
    evidenceRefsClosureDigest: before.envelope.evidenceRefsClosureDigest,
    resolutionHeadNodeId: before.envelope.resolutionHeadNodeId,
    ambiguityDigest:
      node.decision.kind === 'quarantine'
        ? before.envelope.ambiguityDigest
        : observed.envelope.ambiguityDigest,
  };
  const allowedObservedRefDigests =
    node.decision.kind === 'quarantine'
      ? [
          before.envelope.currentRefDigest,
          journal.plannedCurrentWorkflowRef.nextDigest,
        ]
      : [
          journal.plannedCurrentWorkflowRef.expectedDigest,
          journal.plannedCurrentWorkflowRef.nextDigest,
        ];
  const allowedStartReservationDigests = [
    journal.plannedStartReservation.expectedDigest,
    journal.plannedStartReservation.nextDigest,
  ];
  const allowedEvidenceRefsDigests = [
    journal.plannedEvidenceRefs.expectedDigest,
    journal.plannedEvidenceRefs.nextDigest,
  ];
  const allowedEvidenceRefsClosureDigests = [
    journal.plannedEvidenceRefs.expectedClosureDigest,
    journal.plannedEvidenceRefs.nextClosureDigest,
  ];
  const expectedEvidenceRefs =
    observed.envelope.evidenceRefsDigest ===
    journal.plannedEvidenceRefs.expectedDigest
      ? before.envelope.evidenceRefs
      : observed.envelope.evidenceRefsDigest ===
          journal.plannedEvidenceRefs.nextDigest
        ? journal.plannedEvidenceRefs.nextDigest === null
          ? null
          : journal.plannedEvidenceRefs.retainedRefs
        : undefined;
  if (
    canonicalJson(stableObserved) !== canonicalJson(before.envelope) ||
    !allowedObservedRefDigests.includes(observed.currentRefDigest) ||
    !allowedStartReservationDigests.includes(
      observed.envelope.startReservationDigest,
    ) ||
    !allowedEvidenceRefsDigests.includes(
      observed.envelope.evidenceRefsDigest,
    ) ||
    !allowedEvidenceRefsClosureDigests.includes(
      observed.envelope.evidenceRefsClosureDigest,
    ) ||
    expectedEvidenceRefs === undefined ||
    canonicalJson(observed.envelope.evidenceRefs) !==
      canonicalJson(expectedEvidenceRefs) ||
    ![
      journal.beforeResolutionRef,
      ...(journal.resolutionRefMode === 'quarantine-whole' ? [null] : []),
      journal.plannedResolutionNodeId,
    ].includes(observed.envelope.resolutionHeadNodeId)
  ) {
    throw humanResolutionRecoveryAmbiguous();
  }
}

function buildHumanResolutionReceipt(
  authorization: HumanResolutionExecutionAuthorization,
  journal: HumanResolutionJournal,
  node: HumanResolutionNode,
  afterStateDigest: string,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: 'human-resolution-receipt',
    grantId: authorization.grantId,
    grantDigest: journal.grantDigest,
    target: authorization.target,
    beforeStateDigest: journal.beforeStateDigest,
    afterStateDigest,
    resolutionNodeId: node.nodeId,
    resolutionRefMode: journal.resolutionRefMode,
    evidenceArchiveDigest: journal.evidenceArchiveDigest,
    decision: node.decision,
    consequences: node.consequences,
    plannedCurrentWorkflowRef: journal.plannedCurrentWorkflowRef,
    plannedStartReservation: journal.plannedStartReservation,
    plannedEvidenceRefs: journal.plannedEvidenceRefs,
    recordedAt: journal.createdAt,
  };
}

function updateHumanResolutionJournalPhase(
  journal: HumanResolutionJournal,
  phase: HumanResolutionJournal['phase'],
): HumanResolutionJournal {
  return createHumanResolutionJournal({
    phase,
    grantId: journal.grantId,
    grantDigest: journal.grantDigest,
    target: journal.target,
    beforeStateDigest: journal.beforeStateDigest,
    afterStateDigest: journal.afterStateDigest,
    beforeResolutionRef: journal.beforeResolutionRef,
    resolutionRefMode: journal.resolutionRefMode,
    plannedResolutionNodeId: journal.plannedResolutionNodeId,
    plannedCurrentWorkflowRef: journal.plannedCurrentWorkflowRef,
    plannedStartReservation: journal.plannedStartReservation,
    plannedEvidenceRefs: journal.plannedEvidenceRefs,
    evidenceArchiveDigest: journal.evidenceArchiveDigest,
    receiptDigest: journal.receiptDigest,
    createdAt: journal.createdAt,
  });
}

function publishHumanResolutionJournalPhase(
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  journal: HumanResolutionJournal,
  phase: Exclude<HumanResolutionJournal['phase'], 'grant-consumed'>,
): void {
  if (
    HUMAN_RESOLUTION_JOURNAL_PHASES.indexOf(journal.phase) >=
    HUMAN_RESOLUTION_JOURNAL_PHASES.indexOf(phase)
  ) {
    return;
  }
  writeHumanResolutionJournal(
    context.runtime,
    updateHumanResolutionJournalPhase(journal, phase),
  );
}

const HUMAN_RESOLUTION_JOURNAL_PHASES = [
  'prepared',
  'evidence-refs-published',
  'start-reservation-published',
  'current-ref-published',
  'state-published',
  'receipt-written',
  'completed',
  'grant-consumed',
] as const satisfies readonly HumanResolutionJournal['phase'][];

function readHumanResolutionNodeForRecovery(
  paths: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  journal: HumanResolutionJournal,
): HumanResolutionNode {
  const node = readHumanResolutionNode(paths, journal.plannedResolutionNodeId);
  if (
    node.grantId !== journal.grantId ||
    node.grantDigest !== journal.grantDigest ||
    node.previousResolutionNodeId !== journal.beforeResolutionRef ||
    node.target.workflowId !== journal.target.workflowId
  ) {
    throw humanResolutionRecoveryAmbiguous();
  }
  return node;
}

function maybeSimulateHumanResolutionCrash(
  options: HumanResolutionExecutionOptions,
  phase: NonNullable<HumanResolutionExecutionOptions['simulateCrashAfter']>,
): void {
  if (options.simulateCrashAfter === phase) {
    throw new SimulatedHumanResolutionCrash(phase);
  }
}

function exactHumanResolutionDate(value: Date): Date {
  const date = copyGrantDate(value);
  if (date === null) {
    throw workflowError(
      'HUMAN_RESOLUTION_TIME_INVALID',
      'Human resolution requires an exact timestamp.',
      ExitCode.guard,
    );
  }
  return date;
}

function humanResolutionRecoveryAmbiguous() {
  return workflowError(
    'HUMAN_RESOLUTION_RECOVERY_AMBIGUOUS',
    'Human resolution recovery observed state outside the exact journal.',
    ExitCode.staleState,
  );
}

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function startInvestigationSession(
  cwd: string,
  input: StartInvestigationSessionInput,
): InvestigationStatus {
  assertExactStartInput(input);
  const changeId = assertChangeId(input.changeId);
  const context = loadInvestigationRuntimeContext(cwd);
  const manifestDigest = blindSurveyManifestDigest(input.blindManifest);
  const intentDigest = blindSurveyIntentDigest(input.blindManifest);
  assertStartBinding(context, changeId, input, manifestDigest, intentDigest);

  return withInvestigationTransitionAuthority(
    context.lifecycleRuntime,
    changeId,
    (assertOwned) =>
      startInvestigationSessionUnderLifecycleLock(
        cwd,
        input,
        context,
        assertOwned,
      ),
  );
}

export function startInvestigationSessionUnderLifecycleLock(
  cwd: string,
  input: StartInvestigationSessionInput,
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  authority: HeldChangeTransitionAuthority,
): InvestigationStatus {
  assertExactStartInput(input);
  const changeId = assertChangeId(input.changeId);
  const assertOwned = assertHeldChangeTransitionAuthority(authority, changeId);
  const manifestDigest = blindSurveyManifestDigest(input.blindManifest);
  const intentDigest = blindSurveyIntentDigest(input.blindManifest);
  assertStartBinding(context, changeId, input, manifestDigest, intentDigest);
  assertOwned();
  const lockedContext = loadInvestigationRuntimeContext(cwd);
  assertStableStartContext(context, lockedContext);
  assertStartBinding(
    lockedContext,
    changeId,
    input,
    manifestDigest,
    intentDigest,
  );
  if (input.mandateBinding) {
    assertActiveTaskMandateBindingUnderLifecycleLock(
      cwd,
      input.mandateBinding,
      assertOwned,
    );
  }
  const currentRef = readCurrentInvestigationRef(
    lockedContext.runtime,
    changeId,
  );
  if (currentRef !== null) {
    const current = readInvestigationSession(
      lockedContext.runtime,
      currentRef.investigationId,
    );
    if (current.blindManifestDigest === manifestDigest) {
      assertCurrentInvestigationContext(lockedContext, current);
      const reservation = readInvestigationStartReservation(
        lockedContext.runtime,
        changeId,
      );
      if (reservation === null) {
        throw workflowError(
          'INVESTIGATION_START_RESERVATION_MISSING',
          'Current investigation has no durable start reservation.',
          ExitCode.staleState,
        );
      }
      assertStartReservationSessionBinding(lockedContext, reservation, current);
      authorizeSurveyReservationMandate(cwd, reservation, assertOwned, false);
      return statusFromSession(lockedContext, current);
    }
    throw workflowError(
      'CURRENT_INVESTIGATION_CONFLICT',
      `Change ${changeId} already has a different current investigation.`,
      ExitCode.conflict,
    );
  }

  const existingReservation = readInvestigationStartReservation(
    lockedContext.runtime,
    changeId,
  );
  if (
    existingReservation !== null &&
    existingReservation.manifestDigest !== manifestDigest
  ) {
    throw workflowError(
      'INVESTIGATION_START_RESERVATION_CONFLICT',
      'Change already has a durable start reservation for different intent.',
      ExitCode.conflict,
    );
  }
  const reservation =
    existingReservation ??
    createInvestigationStartReservation(lockedContext.runtime, {
      changeId,
      investigationId: createInvestigationId(),
      repositoryRoot: lockedContext.git.repositoryRealPath,
      gitCommonDirectory: lockedContext.git.gitCommonDirectory,
      branch: lockedContext.git.branch,
      baseline: {
        head: lockedContext.git.head,
        tree: lockedContext.git.tree,
      },
      manifest: input.blindManifest,
      request: input.blindRequest,
      ...(input.mandateBinding ? { mandateBinding: input.mandateBinding } : {}),
      executionPolicy: loadAiAdapterPolicy(
        lockedContext.git.repositoryRealPath,
      ),
    });
  assertStartReservationContext(lockedContext, reservation);
  authorizeSurveyReservationMandate(cwd, reservation, assertOwned, false);
  const reservedInput: StartInvestigationSessionInput = {
    changeId,
    blindManifest: reservation.manifest,
    blindRequest: reservation.request,
    ...(reservation.mandateBinding
      ? { mandateBinding: reservation.mandateBinding }
      : {}),
  };
  const reservedIntentDigest = blindSurveyIntentDigest(reservation.manifest);
  assertStartBinding(
    lockedContext,
    changeId,
    reservedInput,
    reservation.manifestDigest,
    reservedIntentDigest,
  );
  const existingPrepared = providerInvocationExists(
    lockedContext.runtime,
    reservation.invocationId,
  )
    ? readProviderInvocation(lockedContext.runtime, reservation.invocationId)
    : null;
  if (
    existingPrepared !== null &&
    (existingPrepared.changeId !== changeId ||
      canonicalJson(existingPrepared.mandateBinding ?? null) !==
        canonicalJson(reservation.mandateBinding ?? null) ||
      existingPrepared.investigationId !== reservation.investigationId ||
      existingPrepared.attempt !== 1 ||
      existingPrepared.requestDigest !== reservation.requestDigest ||
      existingPrepared.manifestDigest !== reservation.manifestDigest)
  ) {
    throw workflowError(
      'PROVIDER_INVOCATION_COLLISION',
      'The requested blind invocation ID belongs to different durable work.',
      ExitCode.conflict,
    );
  }
  const investigationId = reservation.investigationId;
  ensureProviderExecutionPolicySnapshot(
    lockedContext.runtime,
    reservation.request,
    loadAiAdapterPolicy(lockedContext.git.repositoryRealPath),
  );
  if (existingPrepared === null) {
    createProviderInvocation(lockedContext.runtime, {
      investigationId,
      changeId,
      ...(reservation.mandateBinding
        ? { mandateBinding: reservation.mandateBinding }
        : {}),
      attempt: 1,
      manifest: reservation.manifest,
      request: reservation.request,
    });
  }
  assertOwned();
  const now = new Date().toISOString();
  const session: InvestigationSession = {
    schemaVersion: 1,
    investigationId,
    revision: 0,
    semanticRevision: 0,
    lifecycleRevision: 0,
    state: 'awaiting-main-terms',
    changeId,
    ...(reservation.mandateBinding
      ? { mandateBinding: reservation.mandateBinding }
      : {}),
    repositoryRoot: lockedContext.git.repositoryRealPath,
    gitCommonDirectory: lockedContext.git.gitCommonDirectory,
    branch: lockedContext.git.branch,
    baseline: {
      head: lockedContext.git.head,
      tree: lockedContext.git.tree,
    },
    intentDigest: reservedIntentDigest,
    implementationReconciliationPolicyDigest:
      IMPLEMENTATION_RECONCILIATION_POLICY_DIGEST,
    planReviewCoveragePolicyDigest: GLOBAL_PLAN_REVIEW_COVERAGE_POLICY_DIGEST,
    blindManifestDigest: reservation.manifestDigest,
    blindRequestDigest: reservation.requestDigest,
    blindInvocationIds: [reservation.invocationId],
    currentBlindInvocationId: reservation.invocationId,
    milestones: {
      mainTerms: null,
      blindResult: null,
      reviewerTermSourceNodeId: null,
      groupDispositions: null,
      whyAnswers: null,
    },
    blocker: null,
    createdAt: now,
    updatedAt: now,
  };
  const persistedSession = investigationSessionExists(
    lockedContext.runtime,
    investigationId,
  )
    ? readInvestigationSession(lockedContext.runtime, investigationId)
    : createInvestigationSessionRecord(lockedContext.runtime, session);
  if (
    persistedSession.changeId !== changeId ||
    canonicalJson(persistedSession.mandateBinding ?? null) !==
      canonicalJson(reservation.mandateBinding ?? null) ||
    persistedSession.investigationId !== reservation.investigationId ||
    persistedSession.repositoryRoot !== reservation.repositoryRoot ||
    persistedSession.gitCommonDirectory !== reservation.gitCommonDirectory ||
    persistedSession.branch !== reservation.branch ||
    canonicalJson(persistedSession.baseline) !==
      canonicalJson(reservation.baseline) ||
    persistedSession.intentDigest !== reservedIntentDigest ||
    persistedSession.blindManifestDigest !== reservation.manifestDigest ||
    persistedSession.blindRequestDigest !== reservation.requestDigest ||
    persistedSession.currentBlindInvocationId !== reservation.invocationId ||
    canonicalJson(persistedSession.blindInvocationIds) !==
      canonicalJson([reservation.invocationId])
  ) {
    throw workflowError(
      'INVESTIGATION_SESSION_COLLISION',
      'Recovered investigation state belongs to different blind work.',
      ExitCode.conflict,
    );
  }
  assertOwned();
  const finalContext = loadInvestigationRuntimeContext(cwd);
  assertStableStartContext(lockedContext, finalContext);
  assertStartBinding(
    finalContext,
    changeId,
    reservedInput,
    reservation.manifestDigest,
    reservedIntentDigest,
  );
  createCurrentInvestigationRef(
    finalContext.runtime,
    changeId,
    investigationId,
  );
  assertOwned();
  return statusFromSession(finalContext, persistedSession);
}

export function getInvestigationStatus(
  cwd: string,
  requestedInvestigationId: string,
): InvestigationStatus {
  const context = loadInvestigationRuntimeContext(cwd);
  const investigationId = assertInvestigationId(requestedInvestigationId);
  const session = readInvestigationSession(context.runtime, investigationId);
  assertCurrentInvestigationContext(context, session);
  return statusFromSession(context, session);
}

export function createInvestigationCheckpointEnvelope(
  status: InvestigationStatus,
  payload: MainTermsPayload,
): Extract<InvestigationCheckpointEnvelope, { kind: 'main-terms' }>;
export function createInvestigationCheckpointEnvelope(
  status: InvestigationStatus,
  payload: GroupDispositionsPayload,
): Extract<InvestigationCheckpointEnvelope, { kind: 'group-dispositions' }>;
export function createInvestigationCheckpointEnvelope(
  status: InvestigationStatus,
  payload: WhyAnswersPayload,
): Extract<InvestigationCheckpointEnvelope, { kind: 'why-answers' }>;
export function createInvestigationCheckpointEnvelope(
  status: InvestigationStatus,
  payload: MainTermsPayload | GroupDispositionsPayload | WhyAnswersPayload,
): InvestigationCheckpointEnvelope {
  if (status.checkpoint === null) {
    throw workflowError(
      'INVESTIGATION_CHECKPOINT_NOT_AVAILABLE',
      'The investigation is not waiting for caller input.',
      ExitCode.guard,
    );
  }
  const envelope = {
    schemaVersion: 1 as const,
    kind: status.checkpoint.kind,
    checkpointId: status.checkpoint.checkpointId,
    investigationId: status.investigationId,
    changeId: status.changeId,
    expectedRevision: status.revision,
    baseline: status.baseline,
    intentDigest: status.intentDigest,
    blindManifestDigest: status.blindManifestDigest,
    payload,
  };
  return assertInvestigationCheckpointEnvelope(envelope);
}

export function resumeInvestigationSession(
  cwd: string,
  requestedInvestigationId: string,
  checkpoint?: InvestigationCheckpointEnvelope,
): InvestigationStatus {
  return withInvestigationMutation(
    cwd,
    requestedInvestigationId,
    (context, current) =>
      resumeInvestigationSessionUnlocked(context, current, checkpoint),
  );
}

export function resumeInvestigationSessionUnderAuthority(
  cwd: string,
  changeId: string,
  requestedInvestigationId: string,
  checkpoint: InvestigationCheckpointEnvelope | undefined,
  authority: HeldChangeTransitionAuthority,
): InvestigationStatus {
  const assertOwned = assertHeldChangeTransitionAuthority(authority, changeId);
  return withInvestigationMutation(
    cwd,
    requestedInvestigationId,
    (context, current) =>
      resumeInvestigationSessionUnlocked(context, current, checkpoint),
    { changeId: authority.changeId, assertOwned },
  );
}

function resumeInvestigationSessionUnlocked(
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  current: InvestigationSession,
  checkpoint?: InvestigationCheckpointEnvelope,
): InvestigationStatus {
  if (checkpoint === undefined) {
    const invocation = readProviderInvocation(
      context.runtime,
      current.currentBlindInvocationId,
    );
    if (invocation.state === 'succeeded') {
      return publishProviderResultUnlocked(context, current, {
        expectedRevision: current.revision,
        invocationId: invocation.invocationId,
      });
    }
    return statusFromSession(context, current);
  }

  const envelope = assertInvestigationCheckpointEnvelope(checkpoint);
  assertCheckpointBinding(current, envelope);
  const stored = storedCheckpointFor(current, envelope.kind);
  const digest = checkpointEnvelopeDigest(envelope);
  const contributionDigest = checkpointContributionDigest(envelope);
  if (stored !== null) {
    if (
      stored.envelope.contributionDigest === contributionDigest &&
      stored.envelope.envelope.checkpointId === envelope.checkpointId
    ) {
      return statusFromSession(context, current);
    }
    throw workflowError(
      'INVESTIGATION_CHECKPOINT_CONFLICT',
      'This investigation checkpoint was already satisfied by different input.',
      ExitCode.conflict,
    );
  }

  const expectedKind = expectedCheckpointKind(current);
  if (
    expectedKind !== envelope.kind ||
    envelope.checkpointId !== investigationCheckpointId(current, envelope.kind)
  ) {
    throw workflowError(
      'INVESTIGATION_CHECKPOINT_UNEXPECTED',
      'Caller input does not satisfy the investigation checkpoint now pending.',
      ExitCode.guard,
    );
  }
  const orthogonalMainJoin =
    envelope.kind === 'main-terms' &&
    current.milestones.mainTerms === null &&
    envelope.expectedRevision <= current.revision &&
    envelope.checkpointId === investigationCheckpointId(current, 'main-terms');
  if (envelope.expectedRevision !== current.revision && !orthogonalMainJoin) {
    throw investigationCasMismatch(envelope.expectedRevision, current.revision);
  }

  const next = compareAndSwapInvestigationSession(
    context.runtime,
    current.investigationId,
    current.revision,
    (session) => {
      const milestone: StoredInvestigationCheckpoint = {
        envelopeDigest: digest,
        contributionDigest,
        envelope,
      };
      const milestones = { ...session.milestones };
      if (envelope.kind === 'main-terms') {
        milestones.mainTerms = milestone;
      } else if (envelope.kind === 'group-dispositions') {
        milestones.groupDispositions = milestone;
      } else {
        milestones.whyAnswers = milestone;
      }
      const candidate: InvestigationSession = {
        ...session,
        revision: session.revision + 1,
        milestones,
        updatedAt: new Date().toISOString(),
      };
      candidate.state = deriveInvestigationSessionState(candidate);
      return candidate;
    },
  );
  return statusFromSession(context, next);
}

export function publishProviderResultToInvestigation(
  cwd: string,
  requestedInvestigationId: string,
  input: {
    expectedRevision: number;
    invocationId: string;
  },
): InvestigationStatus {
  return withInvestigationMutation(
    cwd,
    requestedInvestigationId,
    (context, current) =>
      publishProviderResultUnlocked(context, current, input),
  );
}

type ReopenInvestigationForReviewerTermsInput = {
  expectedRevision: number;
  sourceNodeId: string;
  usedReopens: number;
  pendingReviewDigest: string;
  authorizationResolutionNodeId: string | null;
};

type HeldInvestigationAuthority = {
  changeId: string;
  assertOwned: () => void;
};

export function reopenInvestigationForReviewerTerms(
  cwd: string,
  requestedInvestigationId: string,
  input: ReopenInvestigationForReviewerTermsInput,
): InvestigationStatus {
  return reopenInvestigationForReviewerTermsInternal(
    cwd,
    requestedInvestigationId,
    input,
  );
}

export function reopenInvestigationForReviewerTermsUnderAuthority(
  cwd: string,
  changeId: string,
  requestedInvestigationId: string,
  input: ReopenInvestigationForReviewerTermsInput,
  assertOwned: () => void,
): InvestigationStatus {
  return reopenInvestigationForReviewerTermsInternal(
    cwd,
    requestedInvestigationId,
    input,
    { changeId: assertChangeId(changeId), assertOwned },
  );
}

function reopenInvestigationForReviewerTermsInternal(
  cwd: string,
  requestedInvestigationId: string,
  input: ReopenInvestigationForReviewerTermsInput,
  authority?: HeldInvestigationAuthority,
): InvestigationStatus {
  return withInvestigationMutation(
    cwd,
    requestedInvestigationId,
    (context, current) => {
      if (
        current.revision !== input.expectedRevision ||
        !/^[0-9a-f]{64}$/.test(input.sourceNodeId) ||
        !Number.isSafeInteger(input.usedReopens) ||
        input.usedReopens < 0 ||
        !/^[0-9a-f]{64}$/.test(input.pendingReviewDigest)
      ) {
        throw workflowError(
          'INVESTIGATION_REVIEWER_REOPEN_STALE',
          'Reviewer-term reopening is not bound to the current investigation revision.',
          ExitCode.staleState,
        );
      }
      const humanAuthorized =
        current.blocker !== null &&
        !('code' in current.blocker) &&
        current.blocker.reasonCode ===
          'INVESTIGATION_REVIEWER_REOPEN_LIMIT_REACHED' &&
        input.authorizationResolutionNodeId !== null &&
        assertReviewerTermResolutionAuthorization(
          context,
          current,
          input.pendingReviewDigest,
          input.authorizationResolutionNodeId,
          'resume',
        );
      if (
        (humanAuthorized
          ? current.state !== 'human-action-required'
          : current.state !== 'investigation-sealed') ||
        current.milestones.groupDispositions === null ||
        current.milestones.whyAnswers === null ||
        (input.usedReopens >= 2 && !humanAuthorized)
      ) {
        throw workflowError(
          'INVESTIGATION_REVIEWER_REOPEN_INVALID',
          'Reviewer terms exhausted the automatic reopen allowance and require an exact human capability.',
          ExitCode.guard,
        );
      }
      if (current.blocker !== null && !humanAuthorized) {
        throw workflowError(
          'INVESTIGATION_REVIEWER_REOPEN_INVALID',
          'A blocked reviewer-term reopen requires its exact human resolution.',
          ExitCode.guard,
        );
      }
      const next = compareAndSwapInvestigationSession(
        context.runtime,
        current.investigationId,
        current.revision,
        (session) => {
          const candidate: InvestigationSession = {
            ...session,
            revision: session.revision + 1,
            blocker: null,
            milestones: {
              ...session.milestones,
              reviewerTermSourceNodeId: input.sourceNodeId,
              groupDispositions: null,
              whyAnswers: null,
            },
            updatedAt: new Date().toISOString(),
          };
          candidate.state = deriveInvestigationSessionState(candidate);
          return candidate;
        },
      );
      return statusFromSession(context, next);
    },
    authority,
  );
}

function assertReviewerTermResolutionAuthorization(
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  session: InvestigationSession,
  pendingReviewDigest: string,
  resolutionNodeId: string,
  expectedOutcome: 'resume' | 'close-input',
): boolean {
  if (
    session.blocker === null ||
    'code' in session.blocker ||
    session.blocker.reasonCode !==
      'INVESTIGATION_REVIEWER_REOPEN_LIMIT_REACHED' ||
    session.blocker.facts.pendingReviewDigest !== pendingReviewDigest ||
    readHumanResolutionHead(context.runtime, session.investigationId) !==
      resolutionNodeId
  ) {
    return false;
  }
  const node = readHumanResolutionNode(context.runtime, resolutionNodeId);
  if (
    node.target.workflowId !== session.investigationId ||
    node.target.changeId !== session.changeId ||
    node.expected.reasonCode !== session.blocker.reasonCode ||
    node.expected.blockedTransition !== session.blocker.blockedTransition ||
    !humanResolutionNodeBindsCurrentState(context, node)
  ) {
    return false;
  }
  return expectedOutcome === 'resume'
    ? node.decision.kind === 'resume-with-capability'
    : node.decision.kind === 'close-input' ||
        node.decision.kind === 'waive-assurance';
}

function humanResolutionNodeBindsCurrentState(
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  node: HumanResolutionNode,
): boolean {
  const repositoryId = loadMaintainerPolicyForResolution(
    context.git.repositoryRoot,
    context.git.head,
  ).policy.repository.id;
  let observed: InvestigationResolutionState;
  try {
    observed = inspectInvestigationResolutionState(
      context.runtime,
      node.target.workflowId,
      repositoryId,
    );
  } catch {
    return false;
  }
  if (observed.envelope.resolutionHeadNodeId !== node.nodeId) {
    return false;
  }
  return (
    investigationResolutionStateDigest({
      ...observed.envelope,
      resolutionHeadNodeId: node.previousResolutionNodeId,
    }) === node.expected.stateDigest
  );
}

export type ReviewerTermResolutionAuthorization =
  | {
      outcome: 'none';
      resolutionNodeId: null;
    }
  | {
      outcome: 'resume';
      resolutionNodeId: string;
    }
  | {
      outcome: 'close-input';
      resolutionNodeId: string;
      assurance: 'degraded' | 'human-waived';
    };

export function decideReviewerTermReopen(input: {
  usedReopens: number;
  novelTermCount: number;
  humanResolution: ReviewerTermResolutionAuthorization;
}):
  | 'no-novel-terms'
  | 'automatic-reopen'
  | 'human-reopen'
  | 'human-close-input'
  | 'human-action-required' {
  if (
    !Number.isSafeInteger(input.usedReopens) ||
    input.usedReopens < 0 ||
    !Number.isSafeInteger(input.novelTermCount) ||
    input.novelTermCount < 0
  ) {
    throw workflowError(
      'INVESTIGATION_REVIEWER_REOPEN_POLICY_INVALID',
      'Reviewer-term reopen policy input is malformed.',
      ExitCode.usage,
    );
  }
  if (input.novelTermCount === 0) {
    return 'no-novel-terms';
  }
  if (input.usedReopens < 2) {
    return 'automatic-reopen';
  }
  if (input.humanResolution.outcome === 'resume') {
    return 'human-reopen';
  }
  if (input.humanResolution.outcome === 'close-input') {
    return 'human-close-input';
  }
  return 'human-action-required';
}

export function inspectReviewerTermResolutionAuthorization(
  cwd: string,
  requestedInvestigationId: string,
  pendingReviewDigest: string,
): ReviewerTermResolutionAuthorization {
  const context = loadInvestigationRuntimeContext(cwd);
  const investigationId = assertInvestigationId(requestedInvestigationId);
  const session = readInvestigationSession(context.runtime, investigationId);
  if (
    !/^[0-9a-f]{64}$/.test(pendingReviewDigest) ||
    session.blocker === null ||
    'code' in session.blocker ||
    session.blocker.reasonCode !==
      'INVESTIGATION_REVIEWER_REOPEN_LIMIT_REACHED' ||
    session.blocker.facts.pendingReviewDigest !== pendingReviewDigest
  ) {
    return {
      outcome: 'none',
      resolutionNodeId: null,
    };
  }
  const nodeId = readHumanResolutionHead(context.runtime, investigationId);
  if (nodeId === null) {
    return {
      outcome: 'none',
      resolutionNodeId: null,
    };
  }
  const node = readHumanResolutionNode(context.runtime, nodeId);
  if (
    node.target.workflowId !== investigationId ||
    node.target.changeId !== session.changeId ||
    node.expected.reasonCode !== session.blocker.reasonCode ||
    node.expected.blockedTransition !== session.blocker.blockedTransition ||
    !humanResolutionNodeBindsCurrentState(context, node)
  ) {
    return {
      outcome: 'none',
      resolutionNodeId: null,
    };
  }
  if (node.decision.kind === 'resume-with-capability') {
    return { outcome: 'resume', resolutionNodeId: nodeId };
  }
  if (
    node.decision.kind === 'close-input' ||
    node.decision.kind === 'waive-assurance'
  ) {
    return {
      outcome: 'close-input',
      resolutionNodeId: nodeId,
      assurance:
        node.consequences.assurance === 'human-waived'
          ? 'human-waived'
          : 'degraded',
    };
  }
  return {
    outcome: 'none',
    resolutionNodeId: null,
  };
}

type BlockInvestigationForReviewerTermsInput = {
  expectedRevision: number;
  pendingReviewDigest: string;
  usedReopens: number;
  proposedTermCount: number;
};

export function blockInvestigationForReviewerTerms(
  cwd: string,
  requestedInvestigationId: string,
  input: BlockInvestigationForReviewerTermsInput,
): InvestigationStatus {
  return blockInvestigationForReviewerTermsInternal(
    cwd,
    requestedInvestigationId,
    input,
  );
}

export function blockInvestigationForReviewerTermsUnderAuthority(
  cwd: string,
  changeId: string,
  requestedInvestigationId: string,
  input: BlockInvestigationForReviewerTermsInput,
  assertOwned: () => void,
): InvestigationStatus {
  return blockInvestigationForReviewerTermsInternal(
    cwd,
    requestedInvestigationId,
    input,
    { changeId: assertChangeId(changeId), assertOwned },
  );
}

function blockInvestigationForReviewerTermsInternal(
  cwd: string,
  requestedInvestigationId: string,
  input: BlockInvestigationForReviewerTermsInput,
  authority?: HeldInvestigationAuthority,
): InvestigationStatus {
  return withInvestigationMutation(
    cwd,
    requestedInvestigationId,
    (context, current) => {
      if (
        current.revision !== input.expectedRevision ||
        !/^[0-9a-f]{64}$/.test(input.pendingReviewDigest) ||
        !Number.isSafeInteger(input.usedReopens) ||
        input.usedReopens < 2 ||
        !Number.isSafeInteger(input.proposedTermCount) ||
        input.proposedTermCount < 1
      ) {
        throw workflowError(
          'INVESTIGATION_REVIEWER_REOPEN_STALE',
          'Reviewer-term blocker is not bound to the current review and allowance.',
          ExitCode.staleState,
        );
      }
      if (
        current.state !== 'investigation-sealed' ||
        current.blocker !== null ||
        current.milestones.groupDispositions === null ||
        current.milestones.whyAnswers === null
      ) {
        throw workflowError(
          'INVESTIGATION_REVIEWER_REOPEN_INVALID',
          'Only a currently sealed investigation can await reviewer-term human resolution.',
          ExitCode.guard,
        );
      }
      const blocker = createInvestigationHumanActionBlocker({
        reasonCode: 'INVESTIGATION_REVIEWER_REOPEN_LIMIT_REACHED',
        blockedTransition: 'admit-plan-review',
        facts: {
          automaticAllowance: 2,
          humanGrantedAllowance: 0,
          usedReopens: input.usedReopens,
          proposedTermCount: input.proposedTermCount,
          pendingReviewDigest: input.pendingReviewDigest,
        },
      });
      const next = compareAndSwapInvestigationSession(
        context.runtime,
        current.investigationId,
        current.revision,
        (session) => ({
          ...session,
          revision: session.revision + 1,
          state: 'human-action-required',
          blocker,
          updatedAt: new Date().toISOString(),
        }),
      );
      return statusFromSession(context, next);
    },
    authority,
  );
}

type AcknowledgeReviewerTermInputClosureInput = {
  expectedRevision: number;
  pendingReviewDigest: string;
  authorizationResolutionNodeId: string;
};

export function acknowledgeReviewerTermInputClosure(
  cwd: string,
  requestedInvestigationId: string,
  input: AcknowledgeReviewerTermInputClosureInput,
): InvestigationStatus {
  return acknowledgeReviewerTermInputClosureInternal(
    cwd,
    requestedInvestigationId,
    input,
  );
}

export function acknowledgeReviewerTermInputClosureUnderAuthority(
  cwd: string,
  changeId: string,
  requestedInvestigationId: string,
  input: AcknowledgeReviewerTermInputClosureInput,
  assertOwned: () => void,
): InvestigationStatus {
  return acknowledgeReviewerTermInputClosureInternal(
    cwd,
    requestedInvestigationId,
    input,
    { changeId: assertChangeId(changeId), assertOwned },
  );
}

function acknowledgeReviewerTermInputClosureInternal(
  cwd: string,
  requestedInvestigationId: string,
  input: AcknowledgeReviewerTermInputClosureInput,
  authority?: HeldInvestigationAuthority,
): InvestigationStatus {
  return withInvestigationMutation(
    cwd,
    requestedInvestigationId,
    (context, current) => {
      if (
        current.revision !== input.expectedRevision ||
        !assertReviewerTermResolutionAuthorization(
          context,
          current,
          input.pendingReviewDigest,
          input.authorizationResolutionNodeId,
          'close-input',
        )
      ) {
        throw workflowError(
          'INVESTIGATION_REVIEWER_INPUT_CLOSURE_STALE',
          'Reviewer-term input closure is not bound to the exact blocker and grant.',
          ExitCode.staleState,
        );
      }
      const next = compareAndSwapInvestigationSession(
        context.runtime,
        current.investigationId,
        current.revision,
        (session) => {
          const candidate: InvestigationSession = {
            ...session,
            revision: session.revision + 1,
            blocker: null,
            updatedAt: new Date().toISOString(),
          };
          candidate.state = deriveInvestigationSessionState(candidate);
          return candidate;
        },
      );
      return statusFromSession(context, next);
    },
    authority,
  );
}

function publishProviderResultUnlocked(
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  current: InvestigationSession,
  input: {
    expectedRevision: number;
    invocationId: string;
  },
): InvestigationStatus {
  const invocation = readProviderInvocation(
    context.runtime,
    input.invocationId,
  );
  assertProviderPublicationBinding(current, invocation);
  if (invocation.state !== 'succeeded' || invocation.result === null) {
    throw workflowError(
      'PROVIDER_RESULT_NOT_AVAILABLE',
      'Provider invocation has no durable successful result to publish.',
      ExitCode.guard,
    );
  }
  const reference = {
    invocationId: invocation.invocationId,
    requestDigest: invocation.requestDigest,
    outputDigest: invocation.result.outputDigest,
  };
  if (current.milestones.blindResult !== null) {
    if (
      canonicalJson(current.milestones.blindResult) === canonicalJson(reference)
    ) {
      return statusFromSession(context, current);
    }
    throw workflowError(
      'PROVIDER_RESULT_PUBLICATION_CONFLICT',
      'A different provider result is already current.',
      ExitCode.conflict,
    );
  }

  const next = compareAndSwapInvestigationSession(
    context.runtime,
    current.investigationId,
    input.expectedRevision,
    (session) => {
      const candidate: InvestigationSession = {
        ...session,
        revision: session.revision + 1,
        milestones: {
          ...session.milestones,
          blindResult: reference,
        },
        updatedAt: new Date().toISOString(),
      };
      candidate.state = deriveInvestigationSessionState(candidate);
      return candidate;
    },
  );
  return statusFromSession(context, next);
}

export function retryInvestigationProvider(
  cwd: string,
  requestedInvestigationId: string,
  input: RetryInvestigationProviderInput,
): InvestigationStatus {
  return withInvestigationMutation(
    cwd,
    requestedInvestigationId,
    (context, current, assertOwned) =>
      retryInvestigationProviderUnlocked(context, current, input, assertOwned),
  );
}

export function expireInvestigationProviderLease(
  cwd: string,
  requestedInvestigationId: string,
  input: {
    expectedSessionRevision: number;
    expectedInvocationRevision: number;
    now?: string;
  },
): InvestigationStatus {
  return withInvestigationMutation(
    cwd,
    requestedInvestigationId,
    (context, current, assertOwned) => {
      if (current.revision !== input.expectedSessionRevision) {
        throw investigationCasMismatch(
          input.expectedSessionRevision,
          current.revision,
        );
      }
      expireProviderInvocationLeaseUnderLifecycleLock(
        context.runtime,
        current.currentBlindInvocationId,
        {
          expectedRevision: input.expectedInvocationRevision,
          now: input.now,
        },
        assertOwned,
      );
      return statusFromSession(context, current);
    },
  );
}

function retryInvestigationProviderUnlocked(
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  current: InvestigationSession,
  input: RetryInvestigationProviderInput,
  assertOwned: () => void,
): InvestigationStatus {
  const investigationId = current.investigationId;
  if (current.revision !== input.expectedRevision) {
    throw workflowError(
      'INVESTIGATION_CAS_MISMATCH',
      'Investigation session changed before provider retry.',
      ExitCode.conflict,
    );
  }
  if (current.mandateBinding) {
    assertActiveTaskMandateBindingUnderLifecycleLock(
      context.git.repositoryRealPath,
      current.mandateBinding,
      assertOwned,
    );
  }
  const previous = readProviderInvocation(
    context.runtime,
    current.currentBlindInvocationId,
  );
  if (
    previous.state !== 'failed' ||
    previous.failure === null ||
    previous.failure.kind !== 'retryable'
  ) {
    throw workflowError(
      previous.failure?.kind === 'repository-reconciliation-required'
        ? 'PROVIDER_REPOSITORY_RECONCILIATION_REQUIRED'
        : 'PROVIDER_INVOCATION_NOT_RETRYABLE',
      'Provider retry requires an explicit retryable terminal failure.',
      ExitCode.guard,
    );
  }
  const priorRequests = current.blindInvocationIds.map((invocationId) =>
    readProviderInvocationRequest(context.runtime, invocationId),
  );
  const manifest = readBlindSurveyManifest(
    context.runtime,
    previous.invocationId,
  );
  const attempt = previous.attempt + 1;
  const existingReservation = readProviderRetryReservation(
    context.runtime,
    investigationId,
    attempt,
  );
  const currentExecutionPolicy = loadAiAdapterPolicy(
    context.git.repositoryRealPath,
  );
  let retryAuthorization: ReturnType<
    typeof authorizeAutomaticProviderRetry
  > | null = null;
  if (existingReservation === null) {
    assertFreshProviderRetry(current, priorRequests, input.replacementRequest);
    assertReplacementRequestBinding(
      current,
      input.replacementRequest,
      manifest,
    );
    retryAuthorization = assertProviderRetryExecutionDecision(
      context.runtime,
      previous,
      input.replacementRequest,
      currentExecutionPolicy,
      input.executionGrantAuthorization,
    );
  } else if (existingReservation.schemaVersion !== 2) {
    throw workflowError(
      'PROVIDER_RETRY_DECISION_EVIDENCE_REQUIRED',
      'A historical retry reservation without decision evidence cannot authorize new provider work.',
      ExitCode.guard,
    );
  } else if (
    existingReservation.retryDecision.failedAttemptId !==
    `attempt-legacy-${previous.invocationId}`
  ) {
    throw workflowError(
      'PROVIDER_RETRY_DECISION_EVIDENCE_STALE',
      'The durable retry decision does not bind the failed provider Attempt.',
      ExitCode.staleState,
    );
  }
  const reservation =
    existingReservation ??
    createProviderRetryReservation(context.runtime, {
      investigationId,
      changeId: current.changeId,
      attempt,
      previousInvocationId: previous.invocationId,
      manifest,
      request: input.replacementRequest,
      executionPolicy: currentExecutionPolicy,
      executionGrantAuthorization: input.executionGrantAuthorization,
      retryDecision: {
        schemaVersion: 1,
        kind: 'provider-retry-decision-binding',
        executionJobId: retryAuthorization!.job.jobId,
        executionRevision: retryAuthorization!.executionRevision,
        failedAttemptId: retryAuthorization!.attempt.attemptId,
        evidenceDigest: retryAuthorization!.evidenceDigest,
        evaluatedAt: retryAuthorization!.evaluatedAt,
      },
      ...(current.mandateBinding
        ? { mandateBinding: current.mandateBinding }
        : {}),
    });
  if (reservation.schemaVersion === 2) {
    authorizeSurveyRetryReservationMandate(
      context,
      current,
      reservation,
      assertOwned,
    );
  }
  if (
    reservation.changeId !== current.changeId ||
    reservation.previousInvocationId !== previous.invocationId ||
    reservation.manifestDigest !== current.blindManifestDigest
  ) {
    throw workflowError(
      'PROVIDER_RETRY_RESERVATION_CONFLICT',
      'Durable provider retry reservation belongs to another attempt.',
      ExitCode.conflict,
    );
  }
  assertFreshProviderRetry(current, priorRequests, reservation.request);
  assertReplacementRequestBinding(current, reservation.request, manifest);
  if (reservation.schemaVersion === 2) {
    ensureProviderExecutionPolicySnapshotFromSnapshot(
      context.runtime,
      reservation.request,
      reservation.executionPolicySnapshot,
    );
  } else {
    // The v1 branch is retained only for exhaustive typing; replay rejected it
    // above before any provider-side write.
    ensureProviderExecutionPolicySnapshot(
      context.runtime,
      reservation.request,
      currentExecutionPolicy,
    );
  }
  const replacement = providerInvocationExists(
    context.runtime,
    reservation.invocationId,
  )
    ? readProviderInvocation(context.runtime, reservation.invocationId)
    : createProviderInvocation(context.runtime, {
        investigationId,
        changeId: current.changeId,
        ...(reservation.schemaVersion === 2 && reservation.mandateBinding
          ? { mandateBinding: reservation.mandateBinding }
          : {}),
        attempt,
        manifest,
        request: reservation.request,
      });
  if (
    replacement.investigationId !== investigationId ||
    replacement.changeId !== current.changeId ||
    canonicalJson(replacement.mandateBinding ?? null) !==
      canonicalJson(
        reservation.schemaVersion === 2
          ? (reservation.mandateBinding ?? null)
          : null,
      ) ||
    replacement.attempt !== attempt ||
    replacement.requestDigest !== reservation.requestDigest ||
    replacement.manifestDigest !== current.blindManifestDigest
  ) {
    throw workflowError(
      'PROVIDER_INVOCATION_COLLISION',
      'Replacement invocation ID belongs to different durable work.',
      ExitCode.conflict,
    );
  }

  const next = compareAndSwapInvestigationSession(
    context.runtime,
    investigationId,
    input.expectedRevision,
    (session) => {
      const candidate: InvestigationSession = {
        ...session,
        revision: session.revision + 1,
        blindRequestDigest: replacement.requestDigest,
        blindInvocationIds: [
          ...session.blindInvocationIds,
          replacement.invocationId,
        ],
        currentBlindInvocationId: replacement.invocationId,
        updatedAt: new Date().toISOString(),
      };
      candidate.state = deriveInvestigationSessionState(candidate);
      return candidate;
    },
  );
  return statusFromSession(context, next);
}

function assertProviderRetryExecutionDecision(
  paths: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  previous: ProviderInvocationRecord,
  replacementRequest: ProviderInvocationRequest,
  replacementExecutionPolicy: ReturnType<typeof loadAiAdapterPolicy>,
  executionGrantAuthorization?: ProviderExecutionGrantAuthorization,
): ReturnType<typeof authorizeAutomaticProviderRetry> {
  const previousRequest = readProviderInvocationRequest(
    paths,
    previous.invocationId,
  );
  const authorization = authorizeAutomaticProviderRetry(paths, {
    failed: previous,
    failedRequest: previousRequest,
    replacementRequest,
    replacementExecutionPolicy,
    boundedGrantRequest: executionGrantAuthorization?.grantRequest,
    executionGrantAuthorization,
  });
  const prior = authorization;
  const replacementPolicy = providerExecutionPolicySnapshot(replacementRequest);
  const now = authorization.evaluatedAt;
  const decision = authorization.decision;
  const replacementAttemptId = `attempt-legacy-${replacementRequest.invocationId}`;
  if (executionGrantAuthorization !== undefined) {
    assertProviderExecutionGrantAuthorization(
      authorization,
      executionGrantAuthorization,
      replacementAttemptId,
    );
  } else if (!decision.retryable || !decision.automatic) {
    throw workflowError(
      decision.requiredGrant === undefined
        ? 'PROVIDER_RETRY_DECISION_DENIED'
        : 'PROVIDER_RETRY_GRANT_REQUIRED',
      'The execution RetryDecision does not authorize an automatic replacement Attempt.',
      ExitCode.guard,
      { details: { reasonCode: decision.reasonCode } },
    );
  }
  if (
    executionGrantAuthorization === undefined &&
    (decision.retryMode === 'new-context' || decision.retryMode === 'none')
  ) {
    throw workflowError(
      'PROVIDER_RETRY_DECISION_INVALID',
      'The execution RetryDecision returned an invalid replacement mode.',
      ExitCode.guard,
    );
  }
  const policyChanged =
    canonicalJson(prior.attempt.policySnapshot) !==
    canonicalJson(replacementPolicy);
  const retryMode: Exclude<RetryMode, 'new-context' | 'none'> =
    executionGrantAuthorization === undefined
      ? (decision.retryMode as Exclude<RetryMode, 'new-context' | 'none'>)
      : prior.attempt.failure?.retryClass === 'repairable'
        ? 'repair'
        : policyChanged
          ? 'execution-policy-change'
          : 'same-input';
  if (retryMode === 'repair') {
    preflightProviderRepairRetry(paths, {
      history: authorization.sourceInvocationIds.map((invocationId) => ({
        record: readProviderInvocation(paths, invocationId),
        request: readProviderInvocationRequest(paths, invocationId),
      })),
      failedRecord: previous,
      failedRequest: previousRequest,
    });
  }
  if (retryMode === 'strategy-change' && !policyChanged) {
    throw workflowError(
      'PROVIDER_RETRY_STRATEGY_CHANGE_REQUIRED',
      'The repeated failure fingerprint requires a changed provider execution strategy.',
      ExitCode.guard,
      { details: { failureFingerprint: prior.attempt.failureFingerprint } },
    );
  }
  const replacement = createReplacementAttempt({
    workflow: prior.workflow,
    job: prior.job,
    previousAttempt: prior.attempt,
    attemptId: replacementAttemptId,
    retryMode,
    currentExecutionPolicy: replacementPolicy,
    repairContext:
      retryMode === 'repair'
        ? loadProviderExecutionRepairContext(
            paths,
            previous,
            readProviderInvocationRequest(paths, previous.invocationId),
          )
        : undefined,
    strategyChanges:
      retryMode === 'strategy-change'
        ? ['provider-execution-policy-changed']
        : undefined,
    grantId: executionGrantAuthorization?.grantId,
    environmentDigest: providerExecutionEnvironmentDigest(replacementRequest),
    createdAt: now,
  });
  if (
    replacement.job.jobId !== prior.job.jobId ||
    replacement.job.workflowId !== prior.job.workflowId ||
    replacement.job.epoch !== prior.job.epoch ||
    replacement.job.contextDigest !== prior.job.contextDigest ||
    replacement.attempt.attemptNumber !== previous.attempt + 1
  ) {
    throw workflowError(
      'PROVIDER_RETRY_EXECUTION_LINEAGE_INVALID',
      'Replacement provider work changed stable semantic Job identity.',
      ExitCode.staleState,
    );
  }
  return authorization;
}

function assertFreshProviderRetry(
  current: InvestigationSession,
  priorRequests: ProviderInvocationRequest[],
  replacementRequest: ProviderInvocationRequest,
): void {
  if (
    current.blindInvocationIds.includes(replacementRequest.invocationId) ||
    priorRequests.some((request) => request.nonce === replacementRequest.nonce)
  ) {
    throw workflowError(
      'PROVIDER_RETRY_NOT_FRESH',
      'Provider retry requires a new invocation ID and nonce.',
      ExitCode.guard,
    );
  }
}

function withInvestigationMutation(
  cwd: string,
  requestedInvestigationId: string,
  operation: (
    context: ReturnType<typeof loadInvestigationRuntimeContext>,
    current: InvestigationSession,
    assertOwned: () => void,
  ) => InvestigationStatus,
  authority?: HeldInvestigationAuthority,
): InvestigationStatus {
  const initialContext = loadInvestigationRuntimeContext(cwd);
  const investigationId = assertInvestigationId(requestedInvestigationId);
  const initial = readInvestigationSession(
    initialContext.runtime,
    investigationId,
  );
  if (authority !== undefined) {
    authority.assertOwned();
    if (initial.changeId !== authority.changeId) {
      throw workflowError(
        'INVESTIGATION_TRANSITION_UNBOUND',
        'Held investigation authority belongs to another change.',
        ExitCode.guard,
      );
    }
    assertCurrentInvestigationContext(initialContext, initial);
    assertInvestigationProviderHistory(initialContext, initial);
    const result = operation(initialContext, initial, authority.assertOwned);
    authority.assertOwned();
    return result;
  }
  return withInvestigationTransitionAuthority(
    initialContext.lifecycleRuntime,
    initial.changeId,
    (assertOwned) => {
      assertOwned();
      const context = loadInvestigationRuntimeContext(cwd);
      const current = readInvestigationSession(
        context.runtime,
        investigationId,
      );
      assertCurrentInvestigationContext(context, current);
      assertInvestigationProviderHistory(context, current);
      const result = operation(context, current, assertOwned);
      assertOwned();
      return result;
    },
  );
}

function statusFromSession(
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  session: InvestigationSession,
): InvestigationStatus {
  const invocation = readProviderInvocation(
    context.runtime,
    session.currentBlindInvocationId,
  );
  assertProviderPublicationBinding(session, invocation, false);
  assertInvestigationProviderHistory(context, session);
  const checkpointKind = expectedCheckpointKind(session);
  const checkpoint =
    checkpointKind === null
      ? null
      : {
          schemaVersion: 1 as const,
          kind: checkpointKind,
          checkpointId: investigationCheckpointId(session, checkpointKind),
        };
  return deepFreeze({
    kind: 'investigation' as const,
    investigationId: session.investigationId,
    changeId: session.changeId,
    revision: session.revision,
    semanticRevision: session.semanticRevision,
    lifecycleRevision: session.lifecycleRevision,
    state: session.state,
    baseline: { ...session.baseline },
    intentDigest: session.intentDigest,
    blindManifestDigest: session.blindManifestDigest,
    providerInvocationId: session.currentBlindInvocationId,
    provider: {
      state: invocation.state,
      providerId: invocation.providerId,
      attempt: invocation.attempt,
      revision: invocation.revision,
      leaseGeneration: invocation.leaseGeneration,
      leaseExpiresAt: invocation.lease?.expiresAt ?? null,
      failure: invocation.failure,
      resultDigest: invocation.result?.outputDigest ?? null,
    },
    checkpoint,
    nextAction: deriveNextAction(session, invocation),
  });
}

function deriveNextAction(
  session: InvestigationSession,
  invocation: ProviderInvocationRecord,
): InvestigationStatus['nextAction'] {
  if (session.state === 'actor-resolution-required') {
    return 'resolve-actor';
  }
  if (session.state === 'human-action-required') {
    return 'human-action';
  }
  if (session.state === 'awaiting-main-terms') {
    return 'submit-main-terms';
  }
  if (session.state === 'waiting-for-provider') {
    if (invocation.failure?.kind === 'repository-reconciliation-required') {
      return 'reconcile-repository';
    }
    if (invocation.state === 'failed') {
      return 'retry-provider';
    }
    if (
      invocation.state === 'leased' &&
      invocation.lease !== null &&
      Date.now() >= Date.parse(invocation.lease.expiresAt)
    ) {
      return 'expire-provider-lease';
    }
    return invocation.state === 'succeeded'
      ? 'resume-provider-result'
      : 'wait-for-provider';
  }
  if (session.state === 'awaiting-group-dispositions') {
    return 'submit-group-dispositions';
  }
  if (session.state === 'awaiting-ledger-answers') {
    return 'submit-why-answers';
  }
  return 'investigation-complete';
}

function expectedCheckpointKind(
  session: InvestigationSession,
): InvestigationCheckpointKind | null {
  if (session.state === 'awaiting-main-terms') {
    return 'main-terms';
  }
  if (session.state === 'awaiting-group-dispositions') {
    return 'group-dispositions';
  }
  if (session.state === 'awaiting-ledger-answers') {
    return 'why-answers';
  }
  return null;
}

function storedCheckpointFor(
  session: InvestigationSession,
  kind: InvestigationCheckpointKind,
): { envelope: StoredInvestigationCheckpoint } | null {
  const checkpoint =
    kind === 'main-terms'
      ? session.milestones.mainTerms
      : kind === 'group-dispositions'
        ? session.milestones.groupDispositions
        : session.milestones.whyAnswers;
  return checkpoint === null ? null : { envelope: checkpoint };
}

function assertCheckpointBinding(
  session: InvestigationSession,
  envelope: InvestigationCheckpointEnvelope,
): void {
  if (
    envelope.investigationId !== session.investigationId ||
    envelope.changeId !== session.changeId ||
    canonicalJson(envelope.baseline) !== canonicalJson(session.baseline) ||
    envelope.intentDigest !== session.intentDigest ||
    envelope.blindManifestDigest !== session.blindManifestDigest
  ) {
    throw workflowError(
      'INVESTIGATION_CHECKPOINT_STALE',
      'Investigation checkpoint is bound to a different session or baseline.',
      ExitCode.staleState,
    );
  }
}

function assertCurrentInvestigationContext(
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  session: InvestigationSession,
): void {
  const current = readCurrentInvestigationRef(
    context.runtime,
    session.changeId,
  );
  const resolutionNodeId = readHumanResolutionHead(
    context.runtime,
    session.investigationId,
  );
  if (resolutionNodeId !== null) {
    const resolution = readHumanResolutionNode(
      context.runtime,
      resolutionNodeId,
    );
    if (
      resolution.decision.kind === 'abort' ||
      resolution.decision.kind === 'quarantine' ||
      resolution.decision.kind === 'supersede' ||
      resolution.decision.kind === 'repair'
    ) {
      throw workflowError(
        'INVESTIGATION_TERMINALLY_RESOLVED',
        'A terminal human resolution prevents this investigation from being revived.',
        ExitCode.staleState,
      );
    }
  }
  // A session born on a working or ceremony branch must still be able to
  // reach the planning transition, which demands the change's canonical
  // template branch. With the exact pinned head and tree unchanged, moving to
  // that one name is ref renaming within the same lineage, not a context
  // change; every other branch stays a staleness signal.
  const canonicalBranch = context.config.branchTemplate.replaceAll(
    '{changeId}',
    session.changeId,
  );
  if (
    current?.investigationId !== session.investigationId ||
    context.git.repositoryRealPath !== session.repositoryRoot ||
    context.git.gitCommonDirectory !== session.gitCommonDirectory ||
    (context.git.branch !== session.branch &&
      context.git.branch !== canonicalBranch) ||
    context.git.head !== session.baseline.head ||
    context.git.tree !== session.baseline.tree
  ) {
    throw workflowError(
      'INVESTIGATION_CONTEXT_STALE',
      'Investigation repository, branch, baseline, or current ref changed.',
      ExitCode.staleState,
    );
  }
}

function assertProviderPublicationBinding(
  session: InvestigationSession,
  invocation: ProviderInvocationRecord,
  requireCurrent = true,
): void {
  if (
    invocation.investigationId !== session.investigationId ||
    invocation.changeId !== session.changeId ||
    (requireCurrent &&
      invocation.invocationId !== session.currentBlindInvocationId) ||
    invocation.requestDigest !== session.blindRequestDigest ||
    invocation.manifestDigest !== session.blindManifestDigest ||
    invocation.purpose !== 'survey'
  ) {
    throw workflowError(
      'PROVIDER_RESULT_PUBLICATION_STALE',
      'Provider result is not bound to the current blind investigation attempt.',
      ExitCode.staleState,
    );
  }
}

function assertPublishedProviderMilestone(
  session: InvestigationSession,
  invocation: ProviderInvocationRecord,
): void {
  const published = session.milestones.blindResult;
  if (published === null) {
    return;
  }
  if (
    invocation.state !== 'succeeded' ||
    invocation.result === null ||
    published.invocationId !== invocation.invocationId ||
    published.requestDigest !== invocation.requestDigest ||
    published.outputDigest !== invocation.result.outputDigest
  ) {
    throw workflowError(
      'PROVIDER_RESULT_PUBLICATION_STALE',
      'Published provider milestone is not an exact durable successful result.',
      ExitCode.staleState,
    );
  }
}

function assertInvestigationProviderHistory(
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  session: InvestigationSession,
): void {
  const startReservation = readInvestigationStartReservation(
    context.runtime,
    session.changeId,
  );
  if (startReservation === null) {
    throw workflowError(
      'INVESTIGATION_START_RESERVATION_MISSING',
      'Investigation provider history has no durable start reservation.',
      ExitCode.staleState,
    );
  }
  assertStartReservationSessionBinding(context, startReservation, session);
  if (session.currentBlindInvocationId !== session.blindInvocationIds.at(-1)) {
    throw providerHistoryInvalid();
  }

  const invocations = session.blindInvocationIds.map((invocationId) =>
    readProviderInvocation(context.runtime, invocationId),
  );
  const requests = session.blindInvocationIds.map((invocationId) =>
    readProviderInvocationRequest(context.runtime, invocationId),
  );
  if (
    new Set(requests.map((request) => request.nonce)).size !== requests.length
  ) {
    throw providerHistoryInvalid();
  }
  for (const [index, invocation] of invocations.entries()) {
    const attempt = index + 1;
    if (
      invocation.investigationId !== session.investigationId ||
      invocation.changeId !== session.changeId ||
      invocation.attempt !== attempt ||
      invocation.manifestDigest !== session.blindManifestDigest
    ) {
      throw providerHistoryInvalid();
    }
    if (attempt === 1) {
      if (
        invocation.invocationId !== startReservation.invocationId ||
        invocation.requestDigest !== startReservation.requestDigest
      ) {
        throw providerHistoryInvalid();
      }
      continue;
    }
    const retryReservation = readProviderRetryReservation(
      context.runtime,
      session.investigationId,
      attempt,
    );
    const previous = invocations[index - 1];
    if (
      retryReservation === null ||
      previous === undefined ||
      retryReservation.changeId !== session.changeId ||
      retryReservation.previousInvocationId !== previous.invocationId ||
      retryReservation.invocationId !== invocation.invocationId ||
      retryReservation.requestDigest !== invocation.requestDigest ||
      retryReservation.requestDigest !== requests[index]?.requestDigest ||
      retryReservation.manifestDigest !== invocation.manifestDigest ||
      previous.state !== 'failed' ||
      previous.failure?.kind !== 'retryable'
    ) {
      throw providerHistoryInvalid();
    }
  }
  const current = invocations.at(-1);
  if (
    current === undefined ||
    current.requestDigest !== session.blindRequestDigest
  ) {
    throw providerHistoryInvalid();
  }
  assertPublishedProviderMilestone(session, current);
}

function providerHistoryInvalid() {
  return workflowError(
    'INVESTIGATION_PROVIDER_HISTORY_INVALID',
    'Investigation provider attempts do not form the reserved monotonic history.',
    ExitCode.staleState,
  );
}

function assertStartBinding(
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  changeId: string,
  input: StartInvestigationSessionInput,
  manifestDigest: string,
  intentDigest: string,
): void {
  const request = input.blindRequest;
  const manifest = input.blindManifest;
  if (
    manifest.changeId !== changeId ||
    manifest.baseCommit !== context.git.head ||
    manifest.baseTree !== context.git.tree ||
    manifest.repositoryId !== context.config.repositoryName ||
    request.repositoryId !== manifest.repositoryId ||
    request.baseCommit !== manifest.baseCommit ||
    request.baseTree !== manifest.baseTree ||
    request.purpose !== 'survey' ||
    request.roleAssignment.role !== 'blind-surveyor' ||
    request.targetDigest !== intentDigest ||
    request.roleAssignment.targetDigest !== intentDigest ||
    request.inputManifestDigest !== manifestDigest ||
    request.capabilityProfile !== 'repository-read-only'
  ) {
    throw workflowError(
      'INVESTIGATION_BLIND_REQUEST_UNBOUND',
      'Blind provider request is not bound to the sealed manifest and baseline.',
      ExitCode.guard,
    );
  }
}

function assertStableStartContext(
  before: ReturnType<typeof loadInvestigationRuntimeContext>,
  after: ReturnType<typeof loadInvestigationRuntimeContext>,
): void {
  if (
    before.git.repositoryRealPath !== after.git.repositoryRealPath ||
    before.git.gitCommonDirectory !== after.git.gitCommonDirectory ||
    before.config.runtimeDirectory !== after.config.runtimeDirectory ||
    before.git.branch !== after.git.branch ||
    before.git.head !== after.git.head ||
    before.git.tree !== after.git.tree
  ) {
    throw workflowError(
      'INVESTIGATION_START_STALE',
      'Repository identity, branch, or pinned baseline changed during start.',
      ExitCode.staleState,
    );
  }
}

function authorizeSurveyReservationMandate(
  cwd: string,
  reservation: InvestigationStartReservation,
  assertOwned: () => void,
  retry: boolean,
): void {
  if (reservation.mandateBinding === undefined) return;
  authorizeTaskMandateProviderReservationUnderLifecycleLock(
    cwd,
    reservation.mandateBinding,
    reservation.invocationId,
    {
      providerId: reservation.request.providerId,
      dataTypes: ['repository-metadata', 'source-code', 'task-intent'],
      sourceCode: true,
      secrets: false,
      retry,
      budget: null,
      requestDigest: reservation.request.requestDigest,
    },
    assertOwned,
  );
}

function authorizeSurveyRetryReservationMandate(
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  session: InvestigationSession,
  reservation: Extract<
    ReturnType<typeof readProviderRetryReservation>,
    { schemaVersion: 2 }
  >,
  assertOwned: () => void,
): void {
  if (
    canonicalJson(session.mandateBinding ?? null) !==
    canonicalJson(reservation.mandateBinding ?? null)
  ) {
    throw workflowError(
      'TASK_MANDATE_BINDING_STALE',
      'The provider retry reservation does not match its durable task mandate binding.',
      ExitCode.staleState,
    );
  }
  if (reservation.mandateBinding === undefined) return;
  authorizeTaskMandateProviderReservationUnderLifecycleLock(
    context.git.repositoryRealPath,
    reservation.mandateBinding,
    reservation.invocationId,
    {
      providerId: reservation.request.providerId,
      dataTypes: ['repository-metadata', 'source-code', 'task-intent'],
      sourceCode: true,
      secrets: false,
      retry: true,
      budget: null,
      requestDigest: reservation.request.requestDigest,
    },
    assertOwned,
  );
}

function assertStartReservationContext(
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  reservation: {
    repositoryRoot: string;
    gitCommonDirectory: string;
    branch: string | null;
    changeId: string;
    baseline: {
      head: string;
      tree: string;
    };
  },
): void {
  // The same canonical-branch tolerance as the session context: at the exact
  // pinned head and tree, the change's template branch is the one rename the
  // planning transition itself demands.
  const canonicalBranch = context.config.branchTemplate.replaceAll(
    '{changeId}',
    reservation.changeId,
  );
  if (
    reservation.repositoryRoot !== context.git.repositoryRealPath ||
    reservation.gitCommonDirectory !== context.git.gitCommonDirectory ||
    (reservation.branch !== context.git.branch &&
      context.git.branch !== canonicalBranch) ||
    reservation.baseline.head !== context.git.head ||
    reservation.baseline.tree !== context.git.tree
  ) {
    throw workflowError(
      'INVESTIGATION_START_STALE',
      'Durable investigation start belongs to another worktree, branch, or baseline.',
      ExitCode.staleState,
    );
  }
}

function assertStartReservationSessionBinding(
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  reservation: InvestigationStartReservation,
  session: InvestigationSession,
): void {
  assertStartReservationContext(context, reservation);
  const initialInvocation = readProviderInvocation(
    context.runtime,
    reservation.invocationId,
  );
  if (
    session.investigationId !== reservation.investigationId ||
    session.changeId !== reservation.changeId ||
    canonicalJson(session.mandateBinding ?? null) !==
      canonicalJson(reservation.mandateBinding ?? null) ||
    session.repositoryRoot !== reservation.repositoryRoot ||
    session.gitCommonDirectory !== reservation.gitCommonDirectory ||
    session.branch !== reservation.branch ||
    canonicalJson(session.baseline) !== canonicalJson(reservation.baseline) ||
    session.intentDigest !== blindSurveyIntentDigest(reservation.manifest) ||
    session.blindManifestDigest !== reservation.manifestDigest ||
    session.blindInvocationIds[0] !== reservation.invocationId ||
    initialInvocation.investigationId !== reservation.investigationId ||
    initialInvocation.changeId !== reservation.changeId ||
    initialInvocation.attempt !== 1 ||
    initialInvocation.requestDigest !== reservation.requestDigest ||
    initialInvocation.manifestDigest !== reservation.manifestDigest
  ) {
    throw workflowError(
      'INVESTIGATION_START_RESERVATION_CONFLICT',
      'Durable investigation start artifacts disagree.',
      ExitCode.staleState,
    );
  }
}

function assertReplacementRequestBinding(
  session: InvestigationSession,
  request: ProviderInvocationRequest,
  manifest: BlindSurveyManifest,
): void {
  if (
    request.purpose !== 'survey' ||
    request.roleAssignment.role !== 'blind-surveyor' ||
    request.baseCommit !== session.baseline.head ||
    request.baseTree !== session.baseline.tree ||
    request.targetDigest !== session.intentDigest ||
    request.roleAssignment.targetDigest !== session.intentDigest ||
    request.inputManifestDigest !== session.blindManifestDigest ||
    request.repositoryId !== manifest.repositoryId
  ) {
    throw workflowError(
      'PROVIDER_RETRY_REQUEST_UNBOUND',
      'Replacement provider request is not bound to the current investigation.',
      ExitCode.guard,
    );
  }
}

function assertExactStartInput(
  value: unknown,
): asserts value is StartInvestigationSessionInput {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (Object.keys(value).length !== 3 && Object.keys(value).length !== 4) ||
    !Object.prototype.hasOwnProperty.call(value, 'changeId') ||
    !Object.prototype.hasOwnProperty.call(value, 'blindManifest') ||
    !Object.prototype.hasOwnProperty.call(value, 'blindRequest') ||
    (Object.keys(value).length === 4 &&
      !Object.prototype.hasOwnProperty.call(value, 'mandateBinding'))
  ) {
    throw workflowError(
      'INVESTIGATION_START_INPUT_INVALID',
      'Investigation start accepts only changeId, sealed blind inputs, and an optional exact mandate binding.',
      ExitCode.usage,
    );
  }
}

function investigationCasMismatch(expected: number, observed: number) {
  return workflowError(
    'INVESTIGATION_CAS_MISMATCH',
    'Investigation session changed during compare-and-swap.',
    ExitCode.conflict,
    { details: { expectedRevision: expected, observedRevision: observed } },
  );
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
