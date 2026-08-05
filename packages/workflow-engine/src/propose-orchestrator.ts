import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { resolveActorIdentity, type ActorSignal } from './actor-identity.ts';
import { loadAiAdapterPolicy } from './ai-adapter-policy.ts';
import { replaceTextAtomic } from './atomic-text.ts';
import { canonicalJson } from './canonical-json.ts';
import {
  COLLABORATION_GRANT_POLICY_DIGEST,
  type CollaborationGrantRequest,
  type CollaborationGrantExpectedBinding,
} from './collaboration-grant.ts';
import {
  consumeCollaborationGrant,
  consumeCollaborationGrantUnderLifecycleLock,
  readExactConsumedCollaborationGrantUse,
  reserveCollaborationGrantUnderLifecycleLock,
  type CollaborationGrantUseProjection,
} from './collaboration-grant-store.ts';
import {
  loadChecksConfig,
  parseExecutionArtifact,
  parseInvestigationArtifact,
  parsePlanReviewArtifact,
  parseTasks,
  type BehaviorContractRef,
  type ChangeContract,
  type ExecutionArtifact,
  type GuardContract,
} from './contracts.ts';
import {
  compareAndSwapEvidenceRef,
  computeInvestigationEvidenceRefsClosure,
  readEvidenceNode,
  readEvidenceRefs,
  writeEvidenceNode,
} from './evidence-object-store.ts';
import {
  assertStoredEvidenceNode,
  createEvidenceNode,
  type EvidenceNode,
} from './evidence-node.ts';
import { ExitCode, WorkflowError, workflowError } from './errors.ts';
import {
  createReplacementAttempt,
  providerExecutionEnvironmentDigest,
  providerExecutionPolicySnapshot,
} from './execution-core.ts';
import {
  loadProviderExecutionRepairContext,
  preflightProviderRepairRetry,
} from './provider-execution-governance.ts';
import { protectedBranchRef, runGit } from './git.ts';
import {
  expandClassDispositions,
  parseClassDisposition,
} from './class-disposition.ts';
import { parsePathRoleRegistry } from './path-role-registry.ts';
import {
  applyLedgerToFullBlobManifest,
  recordReuseCoverage,
  type ReuseCoverageRecord,
} from './semantic-manifest-reuse.ts';
import {
  deriveEngineFloor,
  derivePinnedDiffPathFacts,
  type ChangedPathFact,
  type ReviewedCounterpartFact,
} from './investigation-floor.ts';
import {
  createInvestigationCoverageNode,
  createInvestigationDispositionNodes,
  deriveClassGroupsWithContext,
  deriveInvestigationGroups,
  readInvestigationGroupNode,
  type InvestigationDispositionInput,
  type ReviewedPathRelationship,
} from './investigation-groups.ts';
import { scanInvestigationTree } from './investigation-scanner.ts';
import {
  acknowledgeReviewerTermInputClosureUnderAuthority,
  blockInvestigationForReviewerTermsUnderAuthority,
  decideReviewerTermReopen,
  getInvestigationStatus,
  inspectReviewerTermResolutionAuthorization,
  reopenInvestigationForReviewerTermsUnderAuthority,
  resumeInvestigationSession,
  retryInvestigationProvider,
  startInvestigationSessionUnderLifecycleLock,
  type InvestigationStatus,
} from './investigation-session.ts';
import {
  assertStoredReviewerTermDelta,
  deriveReviewerTermDelta,
  projectPlanReviewTerms,
} from './investigation-term-projection.ts';
import {
  assertInvestigationCheckpointEnvelope,
  checkpointContributionDigest,
  readCurrentInvestigationRef,
  readHumanResolutionNode,
  readInvestigationSession,
  type InvestigationCheckpointEnvelope,
  type InvestigationSession,
  type StoredInvestigationCheckpoint,
  type GroupDispositionsPayload,
} from './investigation-session-store.ts';
import {
  normalizeInvestigationTerm,
  previewInvestigationTermUnion,
  type InvestigationTermContribution,
  type InvestigationTermRawCounts,
  type PreviewInvestigationTerm,
} from './investigation-terms.ts';
import {
  createInvestigationWhyNodes,
  deriveInvestigationFullBlobManifest,
  type InvestigationFullBlobManifestEntry,
  type InvestigationWhyAnswer,
} from './investigation-why.ts';
import { projectInvestigationLedger } from './investigation-design-projection.ts';
import {
  createInvestigationApplicability,
  INVESTIGATION_APPLICABILITY_POLICY_DIGEST,
  type InvestigationChangeClass,
  type InvestigationExemptionCategory,
  type InvestigationSemanticAuthor,
} from './investigation-applicability.ts';
import {
  assertLegacyPlanMigrationSubject,
  assertPreservedLegacyProjection,
  deriveLegacyPlanMigrationSubject,
  isReplaceableLegacyArtifact,
  legacyMigrationMetadataBytes,
  type LegacyPlanMigrationSubject,
} from './legacy-plan-migration.ts';
import { loadInvestigationRuntimeContext } from './lifecycle-context.ts';
import { parseMaintainerPolicy } from './maintainer-policy.ts';
import {
  createInteractiveSshSigner,
  type MaintainerSignerProvider,
} from './maintainer-signer.ts';
import {
  createMutationClassPolicy,
  type MutationClass,
  type MutationClassRule,
} from './mutation-class-policy.ts';
import { createOpenSpecAdapter } from './openspec-adapter.ts';
import {
  OPENSPEC_ASSET_DEFINITIONS,
  OPENSPEC_ASSET_MANIFEST_PATH,
} from './openspec-planning-asset-contract.ts';
import {
  assertChangeId,
  normalizeExactRepositoryPath,
  normalizePolicyPath,
} from './paths.ts';
import {
  assertActiveTaskMandateBindingUnderLifecycleLock,
  authorizeTaskMandateOperation,
  authorizeTaskMandateProviderReservationUnderLifecycleLock,
  recordTaskMandateProviderInvocationUnderLifecycleLock,
  withActiveTaskMandateBinding,
  type TaskMandateBinding,
  type TaskMandateOptions,
} from './task-mandate.ts';
import {
  type HeldChangeTransitionAuthority,
  withInvestigationTransitionAuthority,
} from './planning-lock.ts';
import {
  commitPlanningTransitionUnderAuthority,
  type PlanningTransitionResult,
} from './planning-transition.ts';
import {
  createPlanReviewDispositionNode,
  createPlanReviewNode,
  createPlanReviewProviderResultNode,
  createPlanReviewTargetSnapshotNode,
  assertPlanReviewSubject,
  planReviewSnapshotLineCount,
  readPlanReviewNode,
  readPlanReviewDispositionNode,
  readPlanReviewTargetSnapshotNode,
  PLAN_REVIEW_OUTPUT_SCHEMA,
  type PlanReviewDispositionEntry,
  type PlanReviewSubmission,
  type PlanReviewSubject,
  type PlanReviewTargetSnapshot,
} from './plan-review.ts';
import {
  deriveInvestigationFirstPlanningSubject,
  resolvePlanReviewPlanningEvidence,
  resolvePlanReviewRepositoryEvidence,
  type InvestigationFirstPlanningSubject,
} from './planning-assurance-validator.ts';
import {
  createProviderInvocationRequest,
  PROPOSE_POLICY_DIGEST,
  type ProviderInvocationRequest,
  type ProviderProcessResult,
} from './provider-contracts.ts';
import {
  createProposeExemptionSession,
  isProposeExemptionInvestigationId,
  readCurrentProposeExemptionSession,
  readProposeExemptionSession,
  retireCurrentProposeExemptionSession,
  type ProposeExemptionSession,
} from './propose-exemption-store.ts';
import {
  BLIND_SURVEY_OUTPUT_SCHEMA,
  blindSurveyIntentDigest,
  blindSurveyManifestDigest,
  createProviderExecutionPolicySnapshot,
  createProviderInvocation,
  ensureProviderExecutionPolicySnapshot,
  ensureProviderExecutionPolicySnapshotFromSnapshot,
  providerInvocationExists,
  providerInvocationManifestDigest,
  readBlindSurveyManifest,
  readPlanReviewSnapshotRuntime,
  readProviderInvocation,
  readProviderInvocationManifest,
  readProviderInvocationRequest,
  readProviderRetryReservation,
  storeProviderExecutionPolicySnapshot,
  validateProviderExecutionPolicySnapshot,
  type BlindSurveyManifest,
  type NormalizedChangeIntent,
  type PlanReviewManifest,
  type ProviderRetryDecisionBinding,
  type ProviderExecutionPolicySnapshotCurrent,
} from './provider-invocation-store.ts';
import {
  assertProviderExecutionGrantAuthorization,
  authorizeAutomaticProviderRetry,
  type ProviderExecutionGrantAuthorization,
} from './provider-retry-decision.ts';
import {
  admitRoleResult,
  authorizeGrantedOrdinaryRole,
  scheduleOrdinaryRole,
  type AdmittedRoleResult,
  type GrantedSameProviderRoleAssignment,
  type ProviderRoleAssignment,
  type RoleParticipant,
  type RecordedRoleParticipant,
} from './role-scheduler.ts';
import {
  readPinnedTrackedTree,
  type TrackedTreeSnapshot,
} from './tracked-tree-reader.ts';

const MAX_CALLER_JSON_BYTES = 4 * 1024 * 1024;
const DIGEST = /^[0-9a-f]{64}$/;
const ATOMIC_TEXT_TEMP_SUFFIX =
  /^([1-9][0-9]*)\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.tmp$/;
const PROPOSE_AUTHORIZATION_SCHEMA = 'workflow-propose-authorization.v2';
const PROPOSE_AUTHORIZATION_OUTPUT_SCHEMA =
  'workflow-propose-authorization-output.v2';
const PLANNING_MATERIALIZATION_REF = 'propose/planning-materialization';
const PLAN_REVIEW_REQUEST_REF = 'propose/plan-review-request';
const PLAN_REVIEW_GRANT_REQUIREMENT_REF =
  'propose/plan-review-grant-requirement';

export type ProposeProviderDriver = (input: {
  paths: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'];
  request: ProviderInvocationRequest;
}) => void;

export type ProposeProviderDispatcher = (
  cwd: string,
  invocationId: string,
) => unknown;

export type ProposeOptions = {
  explicitActor?: string;
  environment?: Record<string, string | undefined>;
  migrateLegacy?: boolean;
  providerDriver?: ProposeProviderDriver;
  providerDispatcher?: ProposeProviderDispatcher;
  taskMandateId?: string;
  taskMandateValidation?: TaskMandateOptions;
  collaborationGrant?: {
    grantId: string;
    now?: Date;
    verifier?: MaintainerSignerProvider;
  };
};

export type ProposeResumeOptions = {
  providerDispatcher?: ProposeProviderDispatcher;
  providerDriver?: ProposeProviderDriver;
  collaborationGrant?: {
    grantId: string;
    now?: Date;
    verifier?: MaintainerSignerProvider;
  };
  collaborationGrantValidation?: {
    now?: Date;
    verifier?: MaintainerSignerProvider;
  };
  executionGrantAuthorization?: ProviderExecutionGrantAuthorization & {
    replacementRequest: ProviderInvocationRequest;
  };
};

export type PlanReviewProgressEnvelope = {
  schemaVersion: 1;
  kind: 'plan-review-progress';
  investigationId: string;
  changeId: string;
  subjectDigest: string;
  invocationId: string;
  requestDigest: string;
};

export type PlanReviewRetryEnvelope = {
  schemaVersion: 1;
  kind: 'plan-review-retry';
  investigationId: string;
  changeId: string;
  expectedRevision: number;
  baseline: {
    head: string;
    tree: string;
  };
  subjectDigest: string;
  planningGenerationId: string;
  expectedReservationNodeId: string;
  failedInvocation: {
    invocationId: string;
    attempt: number;
    revision: number;
    requestDigest: string;
    failureDigest: string;
  };
  acknowledgeProviderCost: true;
};

export type PlanReviewDispositionsEnvelope = {
  schemaVersion: 1;
  kind: 'plan-review-dispositions';
  investigationId: string;
  changeId: string;
  subjectDigest: string;
  reviewNodeId: string;
  reviewResultDigest: string;
  dispositions: PlanReviewDispositionEntry[];
};

export type PlanningContributionPayload = {
  proposal: string;
  design: string;
  specs: Array<{ path: string; content: string }>;
  tasks: string;
  guard: GuardContract;
  executionTasks: ExecutionArtifact['tasks'];
};

export type PlanningContributionEnvelope = {
  schemaVersion: 1;
  kind: 'planning-contribution';
  investigationId: string;
  changeId: string;
  expectedRevision: number;
  baseline: {
    head: string;
    tree: string;
  };
  intentDigest: string;
  blindManifestDigest: string;
  payload: PlanningContributionPayload;
};

export type ExemptionPlanningContributionEnvelope = {
  schemaVersion: 1;
  kind: 'exemption-planning-contribution';
  investigationId: string;
  changeId: string;
  expectedRevision: 0;
  baseline: {
    head: string;
    tree: string;
  };
  intentDigest: string;
  applicabilityDigest: string;
  payload: PlanningContributionPayload;
};

export type InvestigationExemptionRequest = {
  schemaVersion: 1;
  kind: 'investigation-exemption-request';
  intent: NormalizedChangeIntent;
  exemption: {
    category: InvestigationExemptionCategory;
    declaredPaths: string[];
    declaredChangeClasses: InvestigationChangeClass[];
    rationale: string;
    semanticAuthor: InvestigationSemanticAuthor;
    nonTrivialBehaviorReliance: 'none-declared';
    researchBudgetMinutes: number | null;
  };
};

export type ProposeStartInput =
  NormalizedChangeIntent | InvestigationExemptionRequest;

export type ProviderProgressEnvelope = {
  schemaVersion: 1;
  kind: 'provider-progress';
  investigationId: string;
  changeId: string;
  expectedRevision: number;
  baseline: {
    head: string;
    tree: string;
  };
  intentDigest: string;
  blindManifestDigest: string;
};

export type ProviderRetryEnvelope = {
  schemaVersion: 1;
  kind: 'provider-retry';
  investigationId: string;
  changeId: string;
  expectedRevision: number;
  baseline: {
    head: string;
    tree: string;
  };
  intentDigest: string;
  blindManifestDigest: string;
  failedInvocation: {
    invocationId: string;
    attempt: number;
    revision: number;
    requestDigest: string;
    failureDigest: string;
  };
  acknowledgeProviderCost: true;
};

export type ProposeInput =
  | InvestigationCheckpointEnvelope
  | PlanningContributionEnvelope
  | ExemptionPlanningContributionEnvelope
  | ProviderProgressEnvelope
  | ProviderRetryEnvelope
  | PlanReviewRetryEnvelope
  | PlanReviewProgressEnvelope
  | PlanReviewDispositionsEnvelope;

export type ProposePlanReviewStatus = {
  subjectDigest: string;
  planningGenerationId: string;
  invocationId: string;
  requestDigest: string;
  providerId: 'codex' | 'claude';
  state: 'prepared' | 'leased' | 'succeeded' | 'failed';
  failure: { kind: string; code: string; message: string } | null;
  reviewNodeId: string | null;
  reviewResultDigest: string | null;
};

export type ProposeGroupWork = {
  groupId: string;
  termId: string;
  paths: string[];
  hitIds: string[];
  /**
   * What each hit looks like where it landed. An author writing a class
   * predicate is claiming something about this text, so withholding it would
   * leave them guessing at the evidence their claim is checked against.
   */
  hits: Array<{
    path: string;
    surface: 'path' | 'content';
    window: string | null;
    windowTruncated: boolean;
    matchOffset: number;
    matchLength: number;
  }>;
};

export type ProposeFullBlobWork = {
  manifestEntryId: string;
  path: string;
  objectId: string;
  contentSha256: string;
  contentBase64: string;
};

export type ProposeWork = {
  termSources: InvestigationTermRawCounts;
  groups: ProposeGroupWork[];
  fullBlobManifest: ProposeFullBlobWork[];
  authoredInstructions: Array<{
    artifactId: string;
    outputPath: string;
    instruction: string;
    template: string;
  }>;
};

export type ProposeOutput = {
  schemaVersion: 1;
  kind: 'workflow-propose';
  changeId: string;
  state:
    | InvestigationStatus['state']
    | 'actor-resolution-required'
    | 'awaiting-planning-contribution'
    | 'plan-review-required'
    | 'waiting-for-plan-review'
    | 'awaiting-challenge-dispositions'
    | 'planning-complete'
    | 'human-action-required';
  nextAction:
    | InvestigationStatus['nextAction']
    | 'submit-planning-contribution'
    | 'obtain-plan-review'
    | 'wait-for-plan-review'
    | 'retry-plan-review'
    | 'resume-plan-review'
    | 'submit-challenge-dispositions'
    | 'planning-complete'
    | 'human-action';
  investigation: InvestigationStatus | ProposeExemptionSession | null;
  createdDate: string;
  actorResolution:
    | {
        outcome: 'resolved';
        providerId: 'codex' | 'claude';
        assurance: 'self-declared' | 'runtime-hint' | 'adapter-assigned';
        signals: ActorSignal[];
      }
    | {
        outcome: 'actor-resolution-required';
        code: 'ACTOR_IDENTITY_REQUIRED' | 'ACTOR_IDENTITY_CONFLICT';
        signals: ActorSignal[];
      }
    | null;
  inputSchema: Record<string, unknown> | null;
  work: ProposeWork | null;
  materializedArtifacts: Record<string, string> | null;
  planReview: ProposePlanReviewStatus | null;
  planningTransition: PlanningTransitionResult | null;
  /**
   * What the semantic ledger carried for this propose, and what a reviewer is
   * owed as a result. Reported rather than enforced: the review policy decides
   * nothing from it yet, but a saving nobody can see is a saving nobody can
   * check, and this is the surface that makes it visible.
   */
  semanticReuse: ReuseCoverageRecord | null;
};

export type OrdinaryProposeOutput = Omit<ProposeOutput, 'investigation'> & {
  investigation: InvestigationStatus | null;
};

export type ExemptionProposeOutput = Omit<ProposeOutput, 'investigation'> & {
  investigation: ProposeExemptionSession | null;
};

type RebuiltInvestigation = {
  session: InvestigationSession;
  intent: NormalizedChangeIntent;
  floor: ReturnType<typeof deriveEngineFloor>;
  termSources: InvestigationTermRawCounts;
  authorizationNode: EvidenceNode;
  legacyMigration: LegacyPlanMigrationSubject | null;
  providerResultNode: EvidenceNode | null;
  providerRoleResult: AdmittedRoleResult | null;
  reviewerTermSourceNode: EvidenceNode | null;
  reviewerTermSourceNodeIds: string[];
  reviewerTermEvidenceNodes: EvidenceNode[];
  reviewerTermReopenCount: number;
  reviewerTerms: ReviewerTermSourceRecord['terms'];
  reviewerRoleResult: AdmittedRoleResult | null;
  reviewerPriorGroupDispositions: StoredInvestigationCheckpoint | null;
  reviewerPriorWhyAnswers: StoredInvestigationCheckpoint | null;
  contributionNodes: EvidenceNode[];
  termUnionNode: EvidenceNode | null;
  scanNodes: EvidenceNode[];
  inventoryNode: EvidenceNode | null;
  hitNodes: EvidenceNode[];
  groupNodes: EvidenceNode[];
  dispositionNodes: EvidenceNode[];
  coverageNode: EvidenceNode | null;
  fullBlobManifest: InvestigationFullBlobManifestEntry[];
  /**
   * What the ledger carried and why. Present so the reduced WHY manifest is
   * inspectable rather than merely smaller.
   */
  reuseCoverage: ReuseCoverageRecord;
  whyNodes: EvidenceNode[];
};

type ProposeLifecycleStatus = InvestigationStatus | ProposeExemptionSession;

type ProposeGrantAuthorization = {
  grantId: string;
  transitionDigest: string;
  expectedBinding: CollaborationGrantExpectedBinding;
};

const BLIND_SURVEY_GRANT_REASON =
  'No provider-independent blind surveyor is callable for this exact investigation.';
const PLAN_REVIEW_GRANT_REASON =
  'No provider-independent exact-plan reviewer is callable for this exact planning generation.';

function blindSurveyGrantRequest(input: {
  changeId: string;
  baseline: { head: string; tree: string };
  targetDigest: string;
  author: RoleParticipant;
  callableProviderIds: Array<'codex' | 'claude'>;
}): CollaborationGrantRequest | null {
  if (
    input.author.providerId === undefined ||
    input.callableProviderIds.length !== 1 ||
    input.callableProviderIds[0] !== input.author.providerId
  ) {
    return null;
  }
  return {
    changeId: input.changeId,
    taskId: null,
    baselineCommit: input.baseline.head,
    baselineTree: input.baseline.tree,
    targetDigest: input.targetDigest,
    lifecyclePhase: 'blind-survey',
    rolePair: {
      authorRole: 'investigation-author',
      conflictingRole: 'blind-surveyor',
    },
    availableActor: {
      kind: 'provider',
      providerId: input.author.providerId,
      assurance: input.author.identityAssurance,
    },
    degradedForm: 'same-provider-fresh-session',
    reason: BLIND_SURVEY_GRANT_REASON,
    ttlMinutes: 30,
    maxUses: 1,
  };
}

function planReviewGrantRequest(input: {
  changeId: string;
  baseline: { head: string; tree: string };
  targetDigest: string;
  author: RoleParticipant;
  callableProviderIds: Array<'codex' | 'claude'>;
}): CollaborationGrantRequest | null {
  if (
    input.author.providerId === undefined ||
    input.callableProviderIds.length !== 1 ||
    input.callableProviderIds[0] !== input.author.providerId
  ) {
    return null;
  }
  return {
    changeId: input.changeId,
    taskId: null,
    baselineCommit: input.baseline.head,
    baselineTree: input.baseline.tree,
    targetDigest: input.targetDigest,
    lifecyclePhase: 'plan-review',
    rolePair: {
      authorRole: 'plan-author',
      conflictingRole: 'plan-reviewer',
    },
    availableActor: {
      kind: 'provider',
      providerId: input.author.providerId,
      assurance: input.author.identityAssurance,
    },
    degradedForm: 'same-provider-fresh-session',
    reason: PLAN_REVIEW_GRANT_REASON,
    ttlMinutes: 30,
    maxUses: 1,
  };
}

function collaborationGrantRequiredOutput(input: {
  changeId: string;
  actorResolution: Extract<
    ReturnType<typeof resolveActorIdentity>,
    { outcome: 'resolved' }
  >;
  grantRequest: CollaborationGrantRequest | null;
  lifecyclePhase: 'blind-survey' | 'plan-review';
  conflictingRole: 'blind-surveyor' | 'plan-reviewer';
}): OrdinaryProposeOutput {
  return {
    schemaVersion: 1,
    kind: 'workflow-propose',
    changeId: input.changeId,
    state: 'human-action-required',
    nextAction: 'human-action',
    investigation: null,
    createdDate: new Date().toISOString().slice(0, 10),
    actorResolution: {
      outcome: 'resolved',
      providerId: input.actorResolution.actor.providerId,
      assurance: input.actorResolution.actor.assurance,
      signals: input.actorResolution.signals,
    },
    inputSchema: {
      schemaVersion: 1,
      kind: 'collaboration-grant-selection',
      lifecyclePhase: input.lifecyclePhase,
      conflictingRole: input.conflictingRole,
      grantRequest: input.grantRequest,
      allowedDegradedForms:
        input.grantRequest === null
          ? ['caller-supplied']
          : ['same-provider-fresh-session'],
      resumeOption: '--grant <grant-id>',
    },
    work: null,
    materializedArtifacts: null,
    planReview: null,
    planningTransition: null,
    semanticReuse: null,
  };
}

function deriveCollaborationGrantBinding(
  repositoryRoot: string,
  request: CollaborationGrantRequest,
): CollaborationGrantExpectedBinding {
  const policy = loadMaintainerPolicyAtCommit(
    repositoryRoot,
    request.baselineCommit,
  );
  return {
    repositoryId: policy.repository.id,
    repositoryOrigin: policy.repository.origin,
    policyBlob: runGit(repositoryRoot, [
      'rev-parse',
      `${request.baselineCommit}:workflow/maintainer-policy.json`,
    ]).trim(),
    collaborationPolicyDigest: COLLABORATION_GRANT_POLICY_DIGEST,
    changeId: request.changeId,
    taskId: request.taskId,
    baselineCommit: request.baselineCommit,
    baselineTree: request.baselineTree,
    targetDigest: request.targetDigest,
    lifecyclePhase: request.lifecyclePhase,
    rolePair: request.rolePair,
    availableActor: request.availableActor,
    degradedForm: request.degradedForm,
    reason: request.reason,
  };
}

function loadMaintainerPolicyAtCommit(
  repositoryRoot: string,
  baselineCommit: string,
): ReturnType<typeof parseMaintainerPolicy> {
  const policyText = runGit(repositoryRoot, [
    'show',
    `${baselineCommit}:workflow/maintainer-policy.json`,
  ]);
  let policyValue: unknown;
  try {
    policyValue = JSON.parse(policyText);
  } catch (error) {
    throw workflowError(
      'MAINTAINER_POLICY_INVALID',
      'The baseline maintainer policy is not valid JSON.',
      ExitCode.guard,
      {
        details: {
          cause: error instanceof Error ? error.message : String(error),
        },
      },
    );
  }
  return parseMaintainerPolicy(policyValue);
}

function collaborationTransitionDigest(
  expectedBinding: CollaborationGrantExpectedBinding,
): string {
  return sha256(
    canonicalJson({
      schemaVersion: 1,
      kind: 'collaboration-role-transition',
      expectedBinding,
    }),
  );
}

function assertProposeStartContextStable(
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
      'Repository identity, branch, or pinned baseline changed during propose start.',
      ExitCode.staleState,
    );
  }
}

function assertCurrentExemptionContext(
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  session: ProposeExemptionSession,
): void {
  const current = readCurrentProposeExemptionSession(
    context.runtime,
    session.changeId,
  );
  if (!currentExemptionContextMatches(context, session, current)) {
    throw workflowError(
      'PROPOSE_INPUT_STALE',
      'The structured investigation exemption is no longer current for this repository context.',
      ExitCode.staleState,
    );
  }
}

function currentExemptionContextMatches(
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  session: ProposeExemptionSession,
  current: ProposeExemptionSession | null,
): boolean {
  return (
    context.git.repositoryRealPath === session.repositoryRoot &&
    context.git.gitCommonDirectory === session.gitCommonDirectory &&
    context.git.branch === session.branch &&
    context.git.head === session.baseline.head &&
    context.git.tree === session.baseline.tree &&
    current !== null &&
    current.investigationId === session.investigationId &&
    current.revision === session.revision &&
    current.intentDigest === session.intentDigest &&
    current.applicability.applicabilityDigest ===
      session.applicability.applicabilityDigest
  );
}

export function startPropose(
  cwd: string,
  requestedChangeId: string,
  intentInput: NormalizedChangeIntent,
  options?: ProposeOptions,
): OrdinaryProposeOutput;
export function startPropose(
  cwd: string,
  requestedChangeId: string,
  intentInput: InvestigationExemptionRequest,
  options?: ProposeOptions,
): ExemptionProposeOutput;
export function startPropose(
  cwd: string,
  requestedChangeId: string,
  intentInput: unknown,
  options?: ProposeOptions,
): ProposeOutput;
export function startPropose(
  cwd: string,
  requestedChangeId: string,
  intentInput: unknown,
  options: ProposeOptions = {},
): ProposeOutput {
  const changeId = assertChangeId(requestedChangeId);
  const startInput = assertProposeStartInput(intentInput);
  const intent = isInvestigationExemptionRequest(startInput)
    ? startInput.intent
    : startInput;
  const environment = options.environment ?? process.env;
  const actorResolution = resolveActorIdentity({
    ...(options.explicitActor === undefined
      ? {}
      : { explicitActor: options.explicitActor }),
    environment,
  });
  if (actorResolution.outcome === 'actor-resolution-required') {
    return {
      schemaVersion: 1,
      kind: 'workflow-propose',
      changeId,
      state: 'actor-resolution-required',
      nextAction: 'resolve-actor',
      investigation: null,
      createdDate: new Date().toISOString().slice(0, 10),
      actorResolution,
      inputSchema: {
        schemaVersion: 1,
        kind: 'actor-selection',
        allowedProviders: ['claude', 'codex'],
      },
      work: null,
      materializedArtifacts: null,
      planReview: null,
      planningTransition: null,
      semanticReuse: null,
    };
  }

  const mandateAuthorization = options.taskMandateId
    ? authorizeTaskMandateOperation(
        cwd,
        options.taskMandateId,
        { kind: 'candidate-or-design-artifact' },
        {
          ...options.taskMandateValidation,
          changeId,
        },
      )
    : null;

  if (isInvestigationExemptionRequest(startInput)) {
    if (options.migrateLegacy) {
      throw workflowError(
        'LEGACY_MIGRATION_NOT_ELIGIBLE',
        'A legacy plan migration requires the ordinary sealed investigation path.',
        ExitCode.guard,
      );
    }
    return startExemptionPropose(
      cwd,
      changeId,
      startInput,
      actorResolution,
      mandateAuthorization?.binding,
    );
  }

  const context = loadInvestigationRuntimeContext(cwd);
  const initialExemption = readCurrentProposeExemptionSession(
    context.runtime,
    changeId,
  );
  if (
    initialExemption !== null &&
    currentExemptionContextMatches(context, initialExemption, initialExemption)
  ) {
    throw workflowError(
      'CURRENT_INVESTIGATION_EXEMPTION_CONFLICT',
      'The current change already has a structured investigation-exemption branch.',
      ExitCode.conflict,
    );
  }
  const adapterPolicy = loadAiAdapterPolicy(context.git.repositoryRoot);
  const intentDigest = sha256(canonicalJson(intent));
  const invocationId = createRuntimeId('invocation');
  const providerSessionId = createRuntimeId('provider-session');
  const author: RoleParticipant = {
    providerId: actorResolution.actor.providerId,
    sessionId: `author-${actorResolution.actor.providerId}`,
    principalId: undefined,
    identityAssurance: actorResolution.actor.assurance,
    engineSpawned: false,
  };
  const candidates = (['codex', 'claude'] as const).map((providerId) => ({
    providerId,
    sessionId:
      providerId === actorResolution.actor.providerId
        ? `author-${providerSessionId}`
        : providerSessionId,
    enabled: adapterPolicy.policy.providers[providerId].enabled,
    available: adapterPolicy.policy.providers[providerId].enabled,
  }));
  const scheduled = scheduleOrdinaryRole({
    role: 'blind-surveyor',
    author,
    targetDigest: intentDigest,
    candidates,
  });
  const callableProviderIds = candidates
    .filter(({ enabled, available }) => enabled && available)
    .map(({ providerId }) => providerId);
  const grantRequest = blindSurveyGrantRequest({
    changeId,
    baseline: { head: context.git.head, tree: context.git.tree },
    targetDigest: intentDigest,
    author,
    callableProviderIds,
  });
  if (scheduled.outcome !== 'assigned' && !options.collaborationGrant) {
    return collaborationGrantRequiredOutput({
      changeId,
      actorResolution,
      grantRequest,
      lifecyclePhase: 'blind-survey',
      conflictingRole: 'blind-surveyor',
    });
  }
  if (scheduled.outcome !== 'assigned' && grantRequest === null) {
    throw workflowError(
      'COLLABORATION_GRANT_FORM_REQUIRED',
      'No provider is callable; submit an explicitly typed caller-supplied survey grant.',
      ExitCode.guard,
    );
  }
  const protectedBranch = context.config.protectedBranches[0];
  if (!protectedBranch) {
    throw workflowError(
      'PROPOSE_BASE_REF_REQUIRED',
      'A configured protected base is required for pinned floor derivation.',
      ExitCode.guard,
    );
  }
  const protectedBaseRef = protectedBranchRef(protectedBranch);
  const protectedBaseCommit = runGit(context.git.repositoryRoot, [
    'rev-parse',
    '--verify',
    `${protectedBaseRef}^{commit}`,
  ]).trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(protectedBaseCommit)) {
    throw workflowError(
      'PROPOSE_BASE_REF_INVALID',
      'The configured protected base did not resolve to an exact commit.',
      ExitCode.staleState,
    );
  }

  const legacyMigration = options.migrateLegacy
    ? deriveLegacyPlanMigrationSubject({
        repositoryRoot: context.git.repositoryRoot,
        changeRoot: context.config.changeRoot,
        changeId,
        baseline: { head: context.git.head, tree: context.git.tree },
      })
    : null;

  const manifest: BlindSurveyManifest = {
    schemaVersion: 1,
    kind: 'blind-survey-manifest',
    changeId,
    repositoryId: context.config.repositoryName,
    baseCommit: context.git.head,
    baseTree: context.git.tree,
    normalizedIntent: intent,
    architectureQuestion:
      `Which existing consumers, invariants, and architecture precedents are ` +
      `load-bearing for this change: ${intent.summary}`,
    capabilityProfile: 'repository-read-only',
  };
  const manifestDigest = blindSurveyManifestDigest(manifest);
  const collaborationGrant = options.collaborationGrant;
  const status = withInvestigationTransitionAuthority(
    context.lifecycleRuntime,
    changeId,
    (assertOwned) => {
      assertOwned();
      const lockedContext = loadInvestigationRuntimeContext(cwd);
      assertProposeStartContextStable(context, lockedContext);
      const lockedExemption = readCurrentProposeExemptionSession(
        lockedContext.runtime,
        changeId,
      );
      if (lockedExemption !== null) {
        if (
          currentExemptionContextMatches(
            lockedContext,
            lockedExemption,
            lockedExemption,
          )
        ) {
          throw workflowError(
            'CURRENT_INVESTIGATION_EXEMPTION_CONFLICT',
            'The current change already has a structured investigation-exemption branch.',
            ExitCode.conflict,
          );
        }
        retireCurrentProposeExemptionSession(
          lockedContext.runtime,
          lockedExemption,
          assertOwned,
        );
      }
      const readDurableStart = (startedStatus: InvestigationStatus) => {
        const durableInvocation = readProviderInvocation(
          lockedContext.runtime,
          startedStatus.providerInvocationId,
        );
        const durableRequest = readProviderInvocationRequest(
          lockedContext.runtime,
          startedStatus.providerInvocationId,
        );
        const durableAuthorization = readProposeAuthorization(
          lockedContext.runtime,
          durableRequest,
        );
        if (
          durableAuthorization.actor.providerId !==
          actorResolution.actor.providerId
        ) {
          throw workflowError(
            'CURRENT_INVESTIGATION_ACTOR_CONFLICT',
            'The current investigation is pinned to a different actor.',
            ExitCode.conflict,
          );
        }
        assertOwned();
        return {
          status: startedStatus,
          durableInvocation,
          durableRequest,
          durableAuthorization,
        };
      };
      const currentRef = readCurrentInvestigationRef(
        lockedContext.runtime,
        changeId,
      );
      if (currentRef !== null) {
        const current = readInvestigationSession(
          lockedContext.runtime,
          currentRef.investigationId,
        );
        if (current.blindManifestDigest !== manifestDigest) {
          throw workflowError(
            'CURRENT_INVESTIGATION_CONFLICT',
            `Change ${changeId} already has a different current investigation.`,
            ExitCode.conflict,
          );
        }
        const durableRequest = readProviderInvocationRequest(
          lockedContext.runtime,
          current.currentBlindInvocationId,
        );
        const durableManifest = readBlindSurveyManifest(
          lockedContext.runtime,
          current.currentBlindInvocationId,
        );
        return readDurableStart(
          startInvestigationSessionUnderLifecycleLock(
            cwd,
            {
              changeId,
              blindManifest: durableManifest,
              blindRequest: durableRequest,
            },
            lockedContext,
            assertOwned,
          ),
        );
      }
      let assignment: ProviderRoleAssignment;
      let grantAuthorization: ProposeGrantAuthorization | null = null;
      if (scheduled.outcome === 'assigned') {
        assignment = scheduled.assignment;
      } else {
        if (!collaborationGrant || grantRequest === null) {
          throw workflowError(
            'COLLABORATION_GRANT_FORM_REQUIRED',
            'No provider is callable; submit an explicitly typed caller-supplied survey grant.',
            ExitCode.guard,
          );
        }
        const expectedBinding = deriveCollaborationGrantBinding(
          lockedContext.git.repositoryRoot,
          grantRequest,
        );
        const transitionDigest = collaborationTransitionDigest(expectedBinding);
        const reservation = reserveCollaborationGrantUnderLifecycleLock(
          lockedContext.git.repositoryRoot,
          collaborationGrant.grantId,
          {
            transitionDigest,
            expected: expectedBinding,
            ...(collaborationGrant.now === undefined
              ? {}
              : { now: collaborationGrant.now }),
            ...(collaborationGrant.verifier === undefined
              ? {}
              : { verifier: collaborationGrant.verifier }),
          },
          assertOwned,
        );
        assignment = authorizeGrantedOrdinaryRole({
          role: 'blind-surveyor',
          author,
          targetDigest: intentDigest,
          reservation,
          actualParticipant: {
            providerId: actorResolution.actor.providerId,
            sessionId: providerSessionId,
            principalId: undefined,
            identityAssurance: actorResolution.actor.assurance,
            engineSpawned: true,
          },
          callableProviderIds,
        }) as GrantedSameProviderRoleAssignment;
        grantAuthorization = {
          grantId: reservation.grantId,
          transitionDigest,
          expectedBinding,
        };
      }
      const authorizationNode = createEvidenceNode({
        type: 'propose-authorization',
        nodeSchema: PROPOSE_AUTHORIZATION_SCHEMA,
        evaluator: 'workflow-propose.v1',
        policyDigest: PROPOSE_POLICY_DIGEST,
        exactInputDigests: {
          actorResolution: sha256(
            canonicalJson({
              actor: actorResolution.actor,
              signals: actorResolution.signals,
            }),
          ),
          assignment: sha256(canonicalJson(assignment)),
          grantAuthorization: sha256(canonicalJson(grantAuthorization)),
          baseline: sha256(
            canonicalJson({
              head: lockedContext.git.head,
              tree: lockedContext.git.tree,
            }),
          ),
          intent: intentDigest,
          legacyMigration: sha256(canonicalJson(legacyMigration)),
          protectedBase: sha256(
            canonicalJson({
              ref: protectedBaseRef,
              commit: protectedBaseCommit,
            }),
          ),
        },
        semanticParentResultDigests: {},
        provenanceParentNodeIds: {},
        outputSchema: PROPOSE_AUTHORIZATION_OUTPUT_SCHEMA,
        output: {
          actor: actorResolution.actor,
          signals: actorResolution.signals,
          assignment,
          grantAuthorization,
          intent,
          legacyMigration,
          baseline: {
            head: lockedContext.git.head,
            tree: lockedContext.git.tree,
          },
          protectedBase: {
            ref: protectedBaseRef,
            commit: protectedBaseCommit,
          },
        },
        runtimeMetadata: {},
      });
      const request = createProviderInvocationRequest({
        invocationId,
        nonce: `propose-${crypto.randomUUID()}`,
        purpose: 'survey',
        providerId: assignment.providerId,
        roleAssignment: assignment,
        capabilityProfile: 'repository-read-only',
        repositoryId: lockedContext.config.repositoryName,
        baseCommit: lockedContext.git.head,
        baseTree: lockedContext.git.tree,
        targetDigest: intentDigest,
        inputManifestDigest: manifestDigest,
        authorizationNodeId: authorizationNode.nodeId,
        writeAllowedPaths: [],
        outputSchema: BLIND_SURVEY_OUTPUT_SCHEMA,
        evaluatorVersion: 'blind-survey-evaluator.v1',
        policyDigest: adapterPolicy.digest,
        limits: {
          timeoutMs: adapterPolicy.policy.limits.timeoutMs,
          aggregateOutputBytes:
            adapterPolicy.policy.limits.aggregateOutputBytes,
        },
      });
      writeEvidenceNode(lockedContext.runtime, authorizationNode);
      assertOwned();
      return readDurableStart(
        startInvestigationSessionUnderLifecycleLock(
          cwd,
          {
            changeId,
            blindManifest: manifest,
            blindRequest: request,
            ...(mandateAuthorization
              ? { mandateBinding: mandateAuthorization.binding }
              : {}),
          },
          lockedContext,
          assertOwned,
        ),
      );
    },
  );
  const {
    status: durableStatus,
    durableInvocation,
    durableRequest,
    durableAuthorization,
  } = status;
  if (
    durableInvocation.state === 'prepared' &&
    (options.providerDriver || options.providerDispatcher)
  ) {
    dispatchMandatedProviderInvocation(
      cwd,
      durableRequest.invocationId,
      (runtime, request) => {
        if (options.providerDriver) {
          options.providerDriver({ paths: runtime, request });
        } else if (options.providerDispatcher) {
          options.providerDispatcher(cwd, request.invocationId);
        }
      },
    );
  }

  return renderProposeOutputWithPlanningAuthority(
    cwd,
    durableStatus,
    {
      outcome: 'resolved',
      providerId: durableAuthorization.actor.providerId,
      assurance: durableAuthorization.actor.assurance,
      signals: durableAuthorization.signals,
    },
    options.collaborationGrant,
  );
}

function startExemptionPropose(
  cwd: string,
  changeId: string,
  request: InvestigationExemptionRequest,
  actorResolution: Extract<
    ReturnType<typeof resolveActorIdentity>,
    { outcome: 'resolved' }
  >,
  mandateBinding?: TaskMandateBinding,
): ProposeOutput {
  const context = loadInvestigationRuntimeContext(cwd);
  return withInvestigationTransitionAuthority(
    context.lifecycleRuntime,
    changeId,
    (assertOwned) => {
      assertOwned();
      const lockedContext = loadInvestigationRuntimeContext(cwd);
      assertProposeStartContextStable(context, lockedContext);
      if (mandateBinding) {
        assertActiveTaskMandateBindingUnderLifecycleLock(
          cwd,
          mandateBinding,
          assertOwned,
        );
      }
      const ordinary = readCurrentInvestigationRef(
        lockedContext.runtime,
        changeId,
      );
      if (ordinary !== null) {
        throw workflowError(
          'CURRENT_INVESTIGATION_CONFLICT',
          'The current change already has an ordinary investigation session.',
          ExitCode.conflict,
        );
      }
      const currentExemption = readCurrentProposeExemptionSession(
        lockedContext.runtime,
        changeId,
      );
      if (
        currentExemption !== null &&
        !currentExemptionContextMatches(
          lockedContext,
          currentExemption,
          currentExemption,
        )
      ) {
        retireCurrentProposeExemptionSession(
          lockedContext.runtime,
          currentExemption,
          assertOwned,
        );
      }
      const intentDigest = sha256(canonicalJson(request.intent));
      const applicability = createInvestigationApplicability({
        kind: 'investigation-exemption',
        ...request.exemption,
        baseline: {
          head: lockedContext.git.head,
          tree: lockedContext.git.tree,
        },
        intentDigest,
      });
      if (applicability.kind !== 'investigation-exemption') {
        throw workflowError(
          'INVESTIGATION_EXEMPTION_INVALID',
          'The structured investigation exemption did not produce its exact branch.',
          ExitCode.staleState,
        );
      }
      const applicabilityNode = createEvidenceNode({
        type: 'investigation-applicability',
        nodeSchema: 'investigation.applicability.v1',
        evaluator: 'investigation-applicability.v1',
        policyDigest: INVESTIGATION_APPLICABILITY_POLICY_DIGEST,
        exactInputDigests: {
          applicability: applicability.applicabilityDigest,
        },
        semanticParentResultDigests: {},
        provenanceParentNodeIds: {},
        outputSchema: 'investigation.applicability-output.v1',
        output: applicability,
        runtimeMetadata: {},
      });
      const session = createProposeExemptionSession(lockedContext.runtime, {
        changeId,
        ...(mandateBinding ? { mandateBinding } : {}),
        repositoryRoot: lockedContext.git.repositoryRealPath,
        gitCommonDirectory: lockedContext.git.gitCommonDirectory,
        branch: lockedContext.git.branch,
        baseline: {
          head: lockedContext.git.head,
          tree: lockedContext.git.tree,
        },
        intentDigest,
        intent: request.intent,
        applicability,
        applicabilityNode,
        actor: actorResolution.actor,
        signals: actorResolution.signals,
      });
      if (
        session.actor.providerId !== actorResolution.actor.providerId ||
        session.actor.assurance !== actorResolution.actor.assurance
      ) {
        throw workflowError(
          'CURRENT_INVESTIGATION_ACTOR_CONFLICT',
          'The current structured investigation exemption is pinned to a different actor.',
          ExitCode.conflict,
        );
      }
      assertCurrentExemptionContext(lockedContext, session);
      const scaffold = prepareExemptionPlanningScaffold(cwd, session);
      const output = renderExemptionProposeOutput(cwd, session, scaffold);
      assertOwned();
      return output;
    },
  );
}

function exemptionAwaitingPlanningOutput(
  session: ProposeExemptionSession,
  scaffold: ReturnType<typeof prepareExemptionPlanningScaffold>,
): ExemptionProposeOutput {
  return {
    schemaVersion: 1,
    kind: 'workflow-propose',
    changeId: session.changeId,
    state: 'awaiting-planning-contribution',
    nextAction: 'submit-planning-contribution',
    investigation: session,
    createdDate: session.createdAt.slice(0, 10),
    actorResolution: {
      outcome: 'resolved',
      providerId: session.actor.providerId,
      assurance: session.actor.assurance,
      signals: session.signals,
    },
    inputSchema: exemptionPlanningContributionSchema(session),
    work: {
      termSources: { engine: 0, main: 0, reviewer: 0, survey: 0 },
      groups: [],
      fullBlobManifest: [],
      authoredInstructions: scaffold.instructions,
    },
    materializedArtifacts: null,
    planReview: null,
    planningTransition: null,
    semanticReuse: null,
  };
}

function prepareExemptionPlanningScaffold(
  cwd: string,
  session: ProposeExemptionSession,
  allowAuthoredExisting = false,
  allowManagedPlanReview = false,
  materializeScaffold = true,
): {
  changeDirectory: string;
  investigationBytes: string;
  instructions: ProposeWork['authoredInstructions'];
} {
  const context = loadInvestigationRuntimeContext(cwd);
  const changeDirectory = path.join(
    context.git.repositoryRoot,
    context.config.changeRoot,
    session.changeId,
  );
  const metadataBytes = `schema: expense-app-v2\ncreated: ${session.createdAt.slice(0, 10)}\n`;
  const investigation = parseInvestigationArtifact(
    {
      schemaVersion: 1,
      kind: 'investigation-artifact',
      changeId: session.changeId,
      legacyMigration: false,
      nodes: [session.applicabilityNode],
      currentRefs: {
        investigationApplicability: session.applicabilityNode.nodeId,
      },
      applicability: session.applicability,
    },
    session.changeId,
  );
  const investigationBytes = `${canonicalJson(investigation)}\n`;
  const scaffoldEntries = new Map([
    ['.openspec.yaml', metadataBytes],
    ['investigation.json', investigationBytes],
  ]);
  assertPlanningTargetsCompatible(
    changeDirectory,
    scaffoldEntries,
    true,
    allowAuthoredExisting,
    allowManagedPlanReview,
  );
  if (materializeScaffold) {
    writeManagedEntries(changeDirectory, scaffoldEntries);
  }
  const adapter = createOpenSpecAdapter(context.git.repositoryRoot);
  const proposalInstruction = adapter.instructions(
    session.changeId,
    'expense-app-v2',
    'proposal',
  );
  return {
    changeDirectory,
    investigationBytes,
    instructions: [
      {
        artifactId: 'proposal',
        outputPath: proposalInstruction.outputPath,
        instruction: proposalInstruction.instruction,
        template: proposalInstruction.template,
      },
    ],
  };
}

function resumeExemptionPlanningContribution(
  cwd: string,
  input: ExemptionPlanningContributionEnvelope,
  options: ProposeResumeOptions,
): ExemptionProposeOutput {
  const initialContext = loadInvestigationRuntimeContext(cwd);
  const output = withInvestigationTransitionAuthority(
    initialContext.lifecycleRuntime,
    input.changeId,
    (assertOwned) => {
      assertOwned();
      const lockedContext = loadInvestigationRuntimeContext(cwd);
      assertProposeStartContextStable(initialContext, lockedContext);
      const session = readProposeExemptionSession(
        lockedContext.runtime,
        input.investigationId,
      );
      assertCurrentExemptionContext(lockedContext, session);
      assertExemptionPlanningBinding(session, input);
      const materializedArtifacts = materializeExemptionPlanningContribution(
        cwd,
        session,
        input.payload,
        options.collaborationGrant,
        assertOwned,
      );
      assertOwned();
      assertCurrentExemptionContext(
        loadInvestigationRuntimeContext(cwd),
        session,
      );
      return renderExemptionProposeOutput(
        cwd,
        session,
        prepareExemptionPlanningScaffold(cwd, session, true),
        materializedArtifacts,
      );
    },
  );
  dispatchPreparedPlanReview(cwd, output, options);
  return getExemptionProposeStatus(cwd, input.investigationId);
}

function assertExemptionPlanningBinding(
  session: ProposeExemptionSession,
  input: ExemptionPlanningContributionEnvelope,
): void {
  if (
    input.investigationId !== session.investigationId ||
    input.changeId !== session.changeId ||
    input.expectedRevision !== session.revision ||
    canonicalJson(input.baseline) !== canonicalJson(session.baseline) ||
    input.intentDigest !== session.intentDigest ||
    input.applicabilityDigest !== session.applicability.applicabilityDigest
  ) {
    throw workflowError(
      'PROPOSE_INPUT_STALE',
      'Planning contribution is not bound to the current structured investigation exemption.',
      ExitCode.staleState,
    );
  }
}

export function resumePropose(
  cwd: string,
  requestedChangeId: string,
  inputValue:
    | InvestigationCheckpointEnvelope
    | PlanningContributionEnvelope
    | ProviderProgressEnvelope
    | ProviderRetryEnvelope,
  options?: ProposeResumeOptions,
): OrdinaryProposeOutput;
export function resumePropose(
  cwd: string,
  requestedChangeId: string,
  inputValue: ExemptionPlanningContributionEnvelope,
  options?: ProposeResumeOptions,
): ExemptionProposeOutput;
export function resumePropose(
  cwd: string,
  requestedChangeId: string,
  inputValue:
    | PlanReviewRetryEnvelope
    | PlanReviewProgressEnvelope
    | PlanReviewDispositionsEnvelope,
  options?: ProposeResumeOptions,
): ProposeOutput;
export function resumePropose(
  cwd: string,
  requestedChangeId: string,
  inputValue: unknown,
  options?: ProposeResumeOptions,
): ProposeOutput;
export function resumePropose(
  cwd: string,
  requestedChangeId: string,
  inputValue: unknown,
  options: ProposeResumeOptions = {},
): ProposeOutput {
  const changeId = assertChangeId(requestedChangeId);
  const input = assertProposeInput(inputValue);
  if (input.changeId !== changeId) {
    throw workflowError(
      'PROPOSE_INPUT_STALE',
      'Propose input belongs to another change.',
      ExitCode.staleState,
    );
  }
  if (input.kind === 'exemption-planning-contribution') {
    return resumeExemptionPlanningContribution(cwd, input, options);
  }
  if (input.kind === 'planning-contribution') {
    const initialContext = loadInvestigationRuntimeContext(cwd);
    const output = withInvestigationTransitionAuthority(
      initialContext.lifecycleRuntime,
      changeId,
      (assertOwned) => {
        assertOwned();
        const status = getInvestigationStatus(cwd, input.investigationId);
        assertPlanningBinding(status, input);
        if (status.state !== 'investigation-sealed') {
          throw workflowError(
            'INVESTIGATION_NOT_SEALED',
            'Planning materialization requires a sealed investigation.',
            ExitCode.guard,
          );
        }
        const rebuilt = rebuildInvestigation(
          cwd,
          status.investigationId,
          'consume',
          options.collaborationGrantValidation,
          assertOwned,
        );
        assertOwned();
        const materializedArtifacts = materializePlanningContribution(
          cwd,
          status,
          rebuilt,
          input.payload,
          options.collaborationGrant,
          assertOwned,
        );
        assertOwned();
        const current = getInvestigationStatus(cwd, input.investigationId);
        assertPlanningBinding(current, input);
        return renderProposeOutput(
          cwd,
          current,
          'consume',
          null,
          materializedArtifacts,
          options.collaborationGrantValidation,
          assertOwned,
        );
      },
    );
    dispatchPreparedPlanReview(cwd, output, options);
    return getProposeStatus(cwd, input.investigationId);
  }

  if (input.kind === 'plan-review-progress') {
    return resumePlanReview(cwd, input, options);
  }

  if (input.kind === 'plan-review-dispositions') {
    return completePlanReviewDispositions(cwd, input);
  }

  if (input.kind === 'provider-retry') {
    return resumeProviderRetry(cwd, input, options);
  }

  if (input.kind === 'plan-review-retry') {
    return resumePlanReviewRetry(cwd, input, options);
  }

  if (input.kind === 'provider-progress') {
    const current = getInvestigationStatus(cwd, input.investigationId);
    assertProgressBinding(current, input);
    let resumed: InvestigationStatus;
    if (current.revision === input.expectedRevision) {
      dispatchPreparedInvocation(cwd, current, options.providerDispatcher);
      resumed = resumeInvestigationSession(cwd, input.investigationId);
    } else if (
      current.revision === input.expectedRevision + 1 &&
      isExactPublishedProviderProgressReplay(cwd, current)
    ) {
      resumed = current;
    } else {
      throw workflowError(
        'INVESTIGATION_CAS_MISMATCH',
        'Investigation session changed during provider progress.',
        ExitCode.conflict,
      );
    }
    return renderProposeOutputWithPlanningAuthority(
      cwd,
      resumed,
      null,
      options.collaborationGrantValidation,
    );
  }

  const suppliedCheckpoint = assertInvestigationCheckpointEnvelope(input);
  const before = getInvestigationStatus(
    cwd,
    suppliedCheckpoint.investigationId,
  );
  dispatchPreparedInvocation(cwd, before, options.providerDispatcher);
  let checkpoint = suppliedCheckpoint;
  if (checkpoint.kind === 'group-dispositions') {
    const rebuilt = rebuildInvestigation(
      cwd,
      before.investigationId,
      'consume',
      options.collaborationGrantValidation,
    );
    const effectiveCheckpoint = mergeReviewerReopenCheckpoint(
      rebuilt,
      checkpoint,
    ) as Extract<
      InvestigationCheckpointEnvelope,
      { kind: 'group-dispositions' }
    >;
    checkpoint = effectiveCheckpoint;
    createInvestigationDispositionNodes({
      groupNodes: rebuilt.groupNodes,
      dispositions: expandSubmittedDispositions(
        loadInvestigationRuntimeContext(cwd).git.repositoryRoot,
        {
          scanNodes: rebuilt.scanNodes,
          groupNodes: rebuilt.groupNodes,
          payload: effectiveCheckpoint.payload,
        },
      ),
    });
  } else if (checkpoint.kind === 'why-answers') {
    const rebuilt = rebuildInvestigation(
      cwd,
      before.investigationId,
      'consume',
      options.collaborationGrantValidation,
    );
    const effectiveCheckpoint = mergeReviewerReopenCheckpoint(
      rebuilt,
      checkpoint,
    ) as Extract<InvestigationCheckpointEnvelope, { kind: 'why-answers' }>;
    checkpoint = effectiveCheckpoint;
    createInvestigationWhyNodes({
      manifest: rebuilt.fullBlobManifest,
      hitNodes: rebuilt.hitNodes,
      groupNodes: rebuilt.groupNodes,
      dispositionNodes: rebuilt.dispositionNodes,
      answers: effectiveCheckpoint.payload.answers,
    });
  }

  let status = resumeInvestigationSession(
    cwd,
    checkpoint.investigationId,
    checkpoint,
  );
  if (
    checkpoint.kind === 'main-terms' &&
    status.state === 'waiting-for-provider' &&
    status.provider.state === 'succeeded'
  ) {
    status = resumeInvestigationSession(cwd, checkpoint.investigationId);
  }
  if (
    status.state === 'investigation-sealed' &&
    readInvestigationSession(
      loadInvestigationRuntimeContext(cwd).runtime,
      status.investigationId,
    ).milestones.reviewerTermSourceNodeId !== null
  ) {
    return reconcileReviewerTermPlanningRevision(cwd, status, options);
  }
  return renderProposeOutputWithPlanningAuthority(
    cwd,
    status,
    null,
    options.collaborationGrantValidation,
  );
}

export function createPlanningContributionEnvelope(
  output: OrdinaryProposeOutput,
  payload: PlanningContributionPayload,
): PlanningContributionEnvelope;
export function createPlanningContributionEnvelope(
  output: ExemptionProposeOutput,
  payload: PlanningContributionPayload,
): ExemptionPlanningContributionEnvelope;
export function createPlanningContributionEnvelope(
  output: ProposeOutput,
  payload: PlanningContributionPayload,
): PlanningContributionEnvelope | ExemptionPlanningContributionEnvelope;
export function createPlanningContributionEnvelope(
  output: ProposeOutput,
  payload: PlanningContributionPayload,
): PlanningContributionEnvelope | ExemptionPlanningContributionEnvelope {
  if (
    output.state !== 'awaiting-planning-contribution' ||
    output.investigation === null
  ) {
    throw workflowError(
      'PLANNING_CONTRIBUTION_NOT_AVAILABLE',
      'The propose wrapper is not waiting for planning input.',
      ExitCode.guard,
    );
  }
  const status = output.investigation;
  if (status.state === 'investigation-exempt') {
    return assertExemptionPlanningContributionEnvelope({
      schemaVersion: 1,
      kind: 'exemption-planning-contribution',
      investigationId: status.investigationId,
      changeId: status.changeId,
      expectedRevision: status.revision,
      baseline: status.baseline,
      intentDigest: status.intentDigest,
      applicabilityDigest: status.applicability.applicabilityDigest,
      payload,
    });
  }
  return assertPlanningContributionEnvelope({
    schemaVersion: 1,
    kind: 'planning-contribution',
    investigationId: status.investigationId,
    changeId: status.changeId,
    expectedRevision: status.revision,
    baseline: status.baseline,
    intentDigest: status.intentDigest,
    blindManifestDigest: status.blindManifestDigest,
    payload,
  });
}

export function createProviderProgressEnvelope(
  status: InvestigationStatus,
): ProviderProgressEnvelope {
  return {
    schemaVersion: 1,
    kind: 'provider-progress',
    investigationId: status.investigationId,
    changeId: status.changeId,
    expectedRevision: status.revision,
    baseline: { ...status.baseline },
    intentDigest: status.intentDigest,
    blindManifestDigest: status.blindManifestDigest,
  };
}

export function createProviderRetryEnvelope(
  cwd: string,
  output: ProposeOutput,
  acknowledgement: { acknowledgeProviderCost: true },
): ProviderRetryEnvelope {
  const status = output.investigation;
  if (
    output.nextAction !== 'retry-provider' ||
    status === null ||
    status.state === 'investigation-exempt' ||
    status.provider.state !== 'failed' ||
    status.provider.failure?.kind !== 'retryable' ||
    acknowledgement.acknowledgeProviderCost !== true
  ) {
    throw workflowError(
      'PROVIDER_RETRY_NOT_AVAILABLE',
      'The propose wrapper has no retryable failed blind-survey invocation.',
      ExitCode.guard,
    );
  }
  const context = loadInvestigationRuntimeContext(cwd);
  const request = readProviderInvocationRequest(
    context.runtime,
    status.providerInvocationId,
  );
  const session = readInvestigationSession(
    context.runtime,
    status.investigationId,
  );
  if (request.requestDigest !== session.blindRequestDigest) {
    throw workflowError(
      'PROVIDER_RETRY_BINDING_INVALID',
      'The failed provider request no longer matches the investigation.',
      ExitCode.staleState,
    );
  }
  return {
    schemaVersion: 1,
    kind: 'provider-retry',
    investigationId: status.investigationId,
    changeId: status.changeId,
    expectedRevision: status.revision,
    baseline: { ...status.baseline },
    intentDigest: status.intentDigest,
    blindManifestDigest: status.blindManifestDigest,
    failedInvocation: {
      invocationId: status.providerInvocationId,
      attempt: status.provider.attempt,
      revision: status.provider.revision,
      requestDigest: request.requestDigest,
      failureDigest: sha256(canonicalJson(status.provider.failure)),
    },
    acknowledgeProviderCost: true,
  };
}

export function createPlanReviewProgressEnvelope(
  output: ProposeOutput,
): PlanReviewProgressEnvelope {
  if (!output.investigation || !output.planReview) {
    throw workflowError(
      'PLAN_REVIEW_PROGRESS_NOT_AVAILABLE',
      'The propose wrapper has no current PlanReview invocation.',
      ExitCode.guard,
    );
  }
  return {
    schemaVersion: 1,
    kind: 'plan-review-progress',
    investigationId: output.investigation.investigationId,
    changeId: output.changeId,
    subjectDigest: output.planReview.subjectDigest,
    invocationId: output.planReview.invocationId,
    requestDigest: output.planReview.requestDigest,
  };
}

export function createPlanReviewRetryEnvelope(
  cwd: string,
  output: ProposeOutput,
  acknowledgement: { acknowledgeProviderCost: true },
): PlanReviewRetryEnvelope {
  if (
    output.nextAction !== 'retry-plan-review' ||
    output.investigation === null ||
    output.planReview === null ||
    output.planReview.state !== 'failed' ||
    output.planReview.failure?.kind !== 'retryable' ||
    acknowledgement.acknowledgeProviderCost !== true
  ) {
    throw workflowError(
      'PLAN_REVIEW_RETRY_NOT_AVAILABLE',
      'The propose wrapper has no retryable failed PlanReview invocation.',
      ExitCode.guard,
    );
  }
  const status = getProposeLifecycleStatus(
    cwd,
    output.investigation.investigationId,
  );
  const context = loadInvestigationRuntimeContext(cwd);
  const reservation = readPlanReviewReservation(context.runtime, status);
  if (
    reservation === null ||
    reservation.subject.subjectDigest !== output.planReview.subjectDigest ||
    reservation.request.invocationId !== output.planReview.invocationId ||
    reservation.request.requestDigest !== output.planReview.requestDigest
  ) {
    throw planReviewRetryInputStale();
  }
  const failed = readProviderInvocation(
    context.runtime,
    reservation.request.invocationId,
  );
  if (
    failed.state !== 'failed' ||
    failed.failure === null ||
    failed.failure.kind !== 'retryable'
  ) {
    throw planReviewRetryInputStale();
  }
  return {
    schemaVersion: 1,
    kind: 'plan-review-retry',
    investigationId: status.investigationId,
    changeId: status.changeId,
    expectedRevision: status.revision,
    baseline: { ...status.baseline },
    subjectDigest: reservation.subject.subjectDigest,
    planningGenerationId: reservation.subject.planningGenerationId,
    expectedReservationNodeId: reservation.reservationNode.nodeId,
    failedInvocation: {
      invocationId: failed.invocationId,
      attempt: failed.attempt,
      revision: failed.revision,
      requestDigest: failed.requestDigest,
      failureDigest: sha256(canonicalJson(failed.failure)),
    },
    acknowledgeProviderCost: true,
  };
}

export function createPlanReviewDispositionsEnvelope(
  output: ProposeOutput,
  dispositions: PlanReviewDispositionEntry[],
): PlanReviewDispositionsEnvelope {
  if (
    output.state !== 'awaiting-challenge-dispositions' ||
    !output.investigation ||
    !output.planReview?.reviewNodeId ||
    !output.planReview.reviewResultDigest
  ) {
    throw workflowError(
      'PLAN_REVIEW_DISPOSITIONS_NOT_AVAILABLE',
      'The propose wrapper is not waiting for review dispositions.',
      ExitCode.guard,
    );
  }
  return {
    schemaVersion: 1,
    kind: 'plan-review-dispositions',
    investigationId: output.investigation.investigationId,
    changeId: output.changeId,
    subjectDigest: output.planReview.subjectDigest,
    reviewNodeId: output.planReview.reviewNodeId,
    reviewResultDigest: output.planReview.reviewResultDigest,
    dispositions,
  };
}

export function startProposeFromFile(
  cwd: string,
  changeId: string,
  intentPath: string,
  options: ProposeOptions = {},
): ProposeOutput {
  return startPropose(cwd, changeId, readCallerJson(cwd, intentPath), options);
}

export function resumeProposeFromFile(
  cwd: string,
  changeId: string,
  inputPath: string,
  options: ProposeResumeOptions = {},
): ProposeOutput {
  return resumePropose(cwd, changeId, readCallerJson(cwd, inputPath), options);
}

function dispatchMandatedProviderInvocation(
  cwd: string,
  invocationId: string,
  dispatch: (
    runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
    request: ProviderInvocationRequest,
  ) => void,
): void {
  const initialContext = loadInvestigationRuntimeContext(cwd);
  const initial = readProviderInvocation(initialContext.runtime, invocationId);
  const ownerBinding = durableProviderOwnerMandateBinding(
    initialContext,
    initial.investigationId,
    initial.changeId,
  );
  if (
    canonicalJson(initial.mandateBinding ?? null) !==
    canonicalJson(ownerBinding ?? null)
  ) {
    throw workflowError(
      'TASK_MANDATE_BINDING_STALE',
      'Provider invocation does not match its durable owner mandate binding.',
      ExitCode.staleState,
    );
  }
  if (ownerBinding === undefined) {
    dispatch(
      initialContext.runtime,
      readProviderInvocationRequest(initialContext.runtime, invocationId),
    );
    return;
  }
  withActiveTaskMandateBinding(
    cwd,
    ownerBinding.mandateTaskId,
    {},
    (activeBinding, assertOwned) => {
      if (canonicalJson(activeBinding) !== canonicalJson(ownerBinding)) {
        throw workflowError(
          'TASK_MANDATE_BINDING_STALE',
          'Provider dispatch no longer matches the active Task Mandate.',
          ExitCode.staleState,
        );
      }
      const context = loadInvestigationRuntimeContext(cwd);
      const invocation = readProviderInvocation(context.runtime, invocationId);
      const durableOwnerBinding = durableProviderOwnerMandateBinding(
        context,
        invocation.investigationId,
        invocation.changeId,
      );
      if (
        invocation.state !== 'prepared' ||
        canonicalJson(invocation.mandateBinding ?? null) !==
          canonicalJson(activeBinding) ||
        canonicalJson(durableOwnerBinding ?? null) !==
          canonicalJson(activeBinding)
      ) {
        throw workflowError(
          'TASK_MANDATE_BINDING_STALE',
          'Provider dispatch lost its exact durable Task Mandate binding.',
          ExitCode.staleState,
        );
      }
      const request = readProviderInvocationRequest(
        context.runtime,
        invocationId,
      );
      recordTaskMandateProviderInvocationUnderLifecycleLock(
        cwd,
        activeBinding,
        {
          providerId: request.providerId,
          invocationId,
          requestDigest: request.requestDigest,
          occurredAt: invocation.createdAt,
        },
        assertOwned,
      );
      assertOwned();
      dispatch(context.runtime, request);
      assertOwned();
    },
  );
}

function durableProviderOwnerMandateBinding(
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  investigationId: string,
  changeId: string,
): TaskMandateBinding | undefined {
  const owner = isProposeExemptionInvestigationId(investigationId)
    ? readProposeExemptionSession(context.runtime, investigationId)
    : readInvestigationSession(context.runtime, investigationId);
  if (owner.changeId !== changeId) {
    throw workflowError(
      'TASK_MANDATE_BINDING_STALE',
      'Provider invocation belongs to another durable change owner.',
      ExitCode.staleState,
    );
  }
  return owner.mandateBinding;
}

function dispatchPreparedInvocation(
  cwd: string,
  status: InvestigationStatus,
  dispatcher: ProposeProviderDispatcher | undefined,
): void {
  if (!dispatcher || status.provider.state !== 'prepared') {
    return;
  }
  dispatchMandatedProviderInvocation(
    cwd,
    status.providerInvocationId,
    (_runtime, request) => dispatcher(cwd, request.invocationId),
  );
}

function resumeProviderRetry(
  cwd: string,
  input: ProviderRetryEnvelope,
  options: ProposeResumeOptions,
): ProposeOutput {
  const current = getInvestigationStatus(cwd, input.investigationId);
  assertProviderRetrySessionBinding(current, input);
  const context = loadInvestigationRuntimeContext(cwd);
  const failed = readProviderInvocation(
    context.runtime,
    input.failedInvocation.invocationId,
  );
  const failedRequest = readProviderInvocationRequest(
    context.runtime,
    failed.invocationId,
  );
  const currentExecutionPolicy = loadAiAdapterPolicy(
    context.git.repositoryRoot,
  );
  assertProviderRetryFailureBinding(input, failed, failedRequest);

  let retried: InvestigationStatus;
  if (current.revision === input.expectedRevision) {
    if (current.providerInvocationId !== failed.invocationId) {
      throw providerRetryInputStale();
    }
    try {
      retried = retryInvestigationProvider(cwd, current.investigationId, {
        expectedRevision: input.expectedRevision,
        replacementRequest:
          options.executionGrantAuthorization?.replacementRequest ??
          createProviderInvocationRequest({
            invocationId: createRuntimeId('invocation'),
            nonce: `provider-retry-${crypto.randomUUID()}`,
            purpose: failedRequest.purpose,
            providerId: failedRequest.providerId,
            roleAssignment: failedRequest.roleAssignment,
            capabilityProfile: failedRequest.capabilityProfile,
            repositoryId: failedRequest.repositoryId,
            baseCommit: failedRequest.baseCommit,
            baseTree: failedRequest.baseTree,
            targetDigest: failedRequest.targetDigest,
            inputManifestDigest: failedRequest.inputManifestDigest,
            authorizationNodeId: failedRequest.authorizationNodeId,
            writeAllowedPaths: [],
            outputSchema: failedRequest.outputSchema,
            evaluatorVersion: failedRequest.evaluatorVersion,
            policyDigest: currentExecutionPolicy.digest,
            limits: {
              timeoutMs: currentExecutionPolicy.policy.limits.timeoutMs,
              aggregateOutputBytes:
                currentExecutionPolicy.policy.limits.aggregateOutputBytes,
            },
          }),
        executionGrantAuthorization: options.executionGrantAuthorization,
      });
    } catch (error) {
      if (
        !(error instanceof WorkflowError) ||
        error.code !== 'INVESTIGATION_CAS_MISMATCH'
      ) {
        throw error;
      }
      try {
        retried = readExactProviderRetryReplay(cwd, input, failed);
      } catch (replayError) {
        if (
          replayError instanceof WorkflowError &&
          replayError.code === 'PROVIDER_RETRY_INPUT_STALE'
        ) {
          throw error;
        }
        throw replayError;
      }
    }
  } else {
    retried = readExactProviderRetryReplay(cwd, input, failed, current);
  }

  dispatchPreparedRetryInvocation(cwd, retried, options);
  return getProposeStatus(
    cwd,
    retried.investigationId,
    options.collaborationGrantValidation,
  );
}

function readExactProviderRetryReplay(
  cwd: string,
  input: ProviderRetryEnvelope,
  failed: ReturnType<typeof readProviderInvocation>,
  observed?: InvestigationStatus,
): InvestigationStatus {
  const current =
    observed ?? getInvestigationStatus(cwd, input.investigationId);
  assertProviderRetrySessionBinding(current, input);
  if (current.revision !== input.expectedRevision + 1) {
    throw providerRetryInputStale();
  }
  const context = loadInvestigationRuntimeContext(cwd);
  const reservation = readProviderRetryReservation(
    context.runtime,
    current.investigationId,
    failed.attempt + 1,
  );
  const session = readInvestigationSession(
    context.runtime,
    current.investigationId,
  );
  if (
    reservation === null ||
    reservation.previousInvocationId !== failed.invocationId ||
    reservation.invocationId !== current.providerInvocationId ||
    current.provider.attempt !== failed.attempt + 1 ||
    session.blindInvocationIds.at(-2) !== failed.invocationId ||
    session.blindInvocationIds.at(-1) !== reservation.invocationId
  ) {
    throw providerRetryInputStale();
  }
  return current;
}

function dispatchPreparedRetryInvocation(
  cwd: string,
  status: InvestigationStatus,
  options: ProposeResumeOptions,
): void {
  if (
    status.provider.state !== 'prepared' ||
    (!options.providerDriver && !options.providerDispatcher)
  ) {
    return;
  }
  dispatchMandatedProviderInvocation(
    cwd,
    status.providerInvocationId,
    (runtime, request) => {
      if (options.providerDriver) {
        options.providerDriver({ paths: runtime, request });
      } else if (options.providerDispatcher) {
        options.providerDispatcher(cwd, request.invocationId);
      }
    },
  );
}

function assertProviderRetrySessionBinding(
  current: InvestigationStatus,
  input: ProviderRetryEnvelope,
): void {
  if (
    input.investigationId !== current.investigationId ||
    input.changeId !== current.changeId ||
    canonicalJson(input.baseline) !== canonicalJson(current.baseline) ||
    input.intentDigest !== current.intentDigest ||
    input.blindManifestDigest !== current.blindManifestDigest
  ) {
    throw providerRetryInputStale();
  }
}

function assertProviderRetryFailureBinding(
  input: ProviderRetryEnvelope,
  failed: ReturnType<typeof readProviderInvocation>,
  request: ProviderInvocationRequest,
): void {
  if (
    failed.investigationId !== input.investigationId ||
    failed.changeId !== input.changeId ||
    failed.invocationId !== input.failedInvocation.invocationId ||
    failed.attempt !== input.failedInvocation.attempt ||
    failed.revision !== input.failedInvocation.revision ||
    failed.requestDigest !== input.failedInvocation.requestDigest ||
    request.requestDigest !== input.failedInvocation.requestDigest ||
    failed.state !== 'failed' ||
    failed.failure === null ||
    failed.failure.kind !== 'retryable' ||
    sha256(canonicalJson(failed.failure)) !==
      input.failedInvocation.failureDigest
  ) {
    throw providerRetryInputStale();
  }
}

function providerRetryInputStale() {
  return workflowError(
    'PROVIDER_RETRY_INPUT_STALE',
    'Provider retry input is not bound to the exact failed survey attempt.',
    ExitCode.staleState,
  );
}

function resumePlanReviewRetry(
  cwd: string,
  input: PlanReviewRetryEnvelope,
  options: ProposeResumeOptions,
): ProposeOutput {
  const initialContext = loadInvestigationRuntimeContext(cwd);
  const retried = withInvestigationTransitionAuthority(
    initialContext.lifecycleRuntime,
    input.changeId,
    (assertOwned) => {
      assertOwned();
      const status = getProposeLifecycleStatus(cwd, input.investigationId);
      assertPlanReviewRetryStatusBinding(status, input);
      const context = loadInvestigationRuntimeContext(cwd);
      if (status.state === 'investigation-exempt') {
        assertCurrentExemptionContext(context, status);
      }
      const mandateBinding = durablePlanReviewMandateBinding(context, status);
      if (mandateBinding) {
        assertActiveTaskMandateBindingUnderLifecycleLock(
          cwd,
          mandateBinding,
          assertOwned,
        );
      }
      if (
        readTrackedPlanReview(context.git.repositoryRoot, status.changeId) !==
        null
      ) {
        throw planReviewRetryInputStale();
      }
      let reservation: PlanReviewReservation | null;
      try {
        reservation = readPlanReviewReservation(context.runtime, status);
      } catch (error) {
        if (
          error instanceof WorkflowError &&
          error.code === 'PLAN_REVIEW_REQUEST_STALE'
        ) {
          throw planReviewRetryInputStale();
        }
        throw error;
      }
      if (reservation === null) {
        throw planReviewRetryInputStale();
      }
      if (
        reservation.reservationNode.nodeId !== input.expectedReservationNodeId
      ) {
        assertExactPlanReviewRetryReplay(context.runtime, reservation, input);
        authorizePlanReviewReservationMandate(
          cwd,
          mandateBinding,
          reservation,
          assertOwned,
        );
        ensurePlanReviewInvocation(
          context.git.repositoryRoot,
          context.runtime,
          status,
          reservation,
          mandateBinding,
        );
        return reservation;
      }
      assertPlanReviewRetryFailureBinding(context.runtime, reservation, input);
      const failed = readProviderInvocation(
        context.runtime,
        input.failedInvocation.invocationId,
      );
      const failedRequest = readProviderInvocationRequest(
        context.runtime,
        failed.invocationId,
      );
      const currentExecutionPolicy = loadAiAdapterPolicy(
        context.git.repositoryRoot,
      );
      const replacementRequest =
        options.executionGrantAuthorization?.replacementRequest ??
        createPlanReviewReplacementRequest(input, failedRequest, {
          policyDigest: currentExecutionPolicy.digest,
          limits: {
            timeoutMs: currentExecutionPolicy.policy.limits.timeoutMs,
            aggregateOutputBytes:
              currentExecutionPolicy.policy.limits.aggregateOutputBytes,
          },
        });
      const retryAuthorization = assertPlanReviewRetryExecutionDecision(
        context.runtime,
        failed,
        failedRequest,
        replacementRequest,
        currentExecutionPolicy,
        options.executionGrantAuthorization,
      );
      const replacementSnapshotFiles = readPriorPlanReviewSnapshotFiles(
        context.runtime,
        reservation.manifest,
        failed.invocationId,
      );
      const replacementExecutionPolicySnapshot =
        createProviderExecutionPolicySnapshot(
          replacementRequest,
          currentExecutionPolicy,
          options.executionGrantAuthorization,
        );
      const replacementNode = createPlanReviewReplacementReservationNode(
        reservation,
        reservation.reservationNode,
        input,
        replacementRequest,
        failed.attempt + 1,
        providerRetryDecisionBinding(retryAuthorization),
        replacementExecutionPolicySnapshot,
      );
      writeEvidenceNode(context.runtime, replacementNode);
      compareAndSwapEvidenceRef(context.runtime, {
        changeId: status.changeId,
        refName: PLAN_REVIEW_REQUEST_REF,
        expectedNodeId: reservation.reservationNode.nodeId,
        nextNodeId: replacementNode.nodeId,
      });
      const replacement = readPlanReviewReservation(
        context.runtime,
        status,
        reservation.subject,
      );
      if (replacement === null) {
        throw planReviewRetryInputStale();
      }
      authorizePlanReviewReservationMandate(
        cwd,
        mandateBinding,
        replacement,
        assertOwned,
      );
      ensurePlanReviewInvocation(
        context.git.repositoryRoot,
        context.runtime,
        status,
        replacement,
        mandateBinding,
        replacementSnapshotFiles,
      );
      assertOwned();
      return replacement;
    },
  );
  const output = getProposeStatus(cwd, input.investigationId);
  if (output.planReview?.invocationId !== retried.request.invocationId) {
    throw planReviewRetryInputStale();
  }
  dispatchPreparedPlanReview(cwd, output, options);
  return getProposeStatus(
    cwd,
    input.investigationId,
    options.collaborationGrantValidation,
  );
}

function assertPlanReviewRetryStatusBinding(
  status: ProposeLifecycleStatus,
  input: PlanReviewRetryEnvelope,
): void {
  if (
    status.investigationId !== input.investigationId ||
    status.changeId !== input.changeId ||
    status.revision !== input.expectedRevision ||
    canonicalJson(status.baseline) !== canonicalJson(input.baseline)
  ) {
    throw planReviewRetryInputStale();
  }
}

function assertPlanReviewRetryFailureBinding(
  paths: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  reservation: PlanReviewReservation,
  input: PlanReviewRetryEnvelope,
): void {
  const failed = readProviderInvocation(
    paths,
    input.failedInvocation.invocationId,
  );
  const request = readProviderInvocationRequest(paths, failed.invocationId);
  if (
    reservation.subject.subjectDigest !== input.subjectDigest ||
    reservation.subject.planningGenerationId !== input.planningGenerationId ||
    reservation.request.invocationId !== failed.invocationId ||
    reservation.request.requestDigest !== request.requestDigest ||
    failed.investigationId !== input.investigationId ||
    failed.changeId !== input.changeId ||
    failed.attempt !== (reservation.retry?.attempt ?? 1) ||
    failed.attempt !== input.failedInvocation.attempt ||
    failed.revision !== input.failedInvocation.revision ||
    failed.requestDigest !== input.failedInvocation.requestDigest ||
    failed.state !== 'failed' ||
    failed.failure === null ||
    failed.failure.kind !== 'retryable' ||
    sha256(canonicalJson(failed.failure)) !==
      input.failedInvocation.failureDigest
  ) {
    throw planReviewRetryInputStale();
  }
}

function planReviewRetryBindingDigest(input: PlanReviewRetryEnvelope): string {
  return sha256(
    canonicalJson({
      schemaVersion: input.schemaVersion,
      kind: input.kind,
      investigationId: input.investigationId,
      changeId: input.changeId,
      expectedRevision: input.expectedRevision,
      baseline: input.baseline,
      subjectDigest: input.subjectDigest,
      planningGenerationId: input.planningGenerationId,
      expectedReservationNodeId: input.expectedReservationNodeId,
      failedInvocation: input.failedInvocation,
      acknowledgeProviderCost: input.acknowledgeProviderCost,
    }),
  );
}

function createPlanReviewReplacementRequest(
  input: PlanReviewRetryEnvelope,
  failedRequest: ProviderInvocationRequest,
  executionPolicy: Pick<ProviderInvocationRequest, 'policyDigest' | 'limits'>,
): ProviderInvocationRequest {
  const bindingDigest = planReviewRetryBindingDigest(input);
  return createProviderInvocationRequest({
    invocationId: `invocation-plan-review-retry-${bindingDigest}`,
    nonce: `plan-review-retry-${bindingDigest}`,
    purpose: failedRequest.purpose,
    providerId: failedRequest.providerId,
    roleAssignment: failedRequest.roleAssignment,
    capabilityProfile: failedRequest.capabilityProfile,
    repositoryId: failedRequest.repositoryId,
    baseCommit: failedRequest.baseCommit,
    baseTree: failedRequest.baseTree,
    targetDigest: failedRequest.targetDigest,
    inputManifestDigest: failedRequest.inputManifestDigest,
    authorizationNodeId: failedRequest.authorizationNodeId,
    writeAllowedPaths: [...failedRequest.writeAllowedPaths],
    outputSchema: failedRequest.outputSchema,
    evaluatorVersion: failedRequest.evaluatorVersion,
    policyDigest: executionPolicy.policyDigest,
    limits: executionPolicy.limits,
  });
}

function assertPlanReviewRetryExecutionDecision(
  paths: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  failed: ReturnType<typeof readProviderInvocation>,
  failedRequest: ProviderInvocationRequest,
  replacementRequest: ProviderInvocationRequest,
  replacementExecutionPolicy: ReturnType<typeof loadAiAdapterPolicy>,
  executionGrantAuthorization?: ProviderExecutionGrantAuthorization,
): ReturnType<typeof authorizeAutomaticProviderRetry> {
  const authorization = authorizeAutomaticProviderRetry(paths, {
    failed,
    failedRequest,
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
        ? 'PLAN_REVIEW_RETRY_DECISION_DENIED'
        : 'PLAN_REVIEW_RETRY_GRANT_REQUIRED',
      'The execution RetryDecision does not authorize this PlanReview replacement Attempt.',
      ExitCode.guard,
      {
        details: {
          reasonCode: decision.reasonCode,
          attemptCount: prior.job.attemptCount,
          providerAttemptCount: authorization.providerAttemptCount,
          nextRuntimeMs: authorization.nextReservation.runtimeMs,
          nextProviderCostMicros:
            authorization.nextReservation.providerCostMicros,
          nextProviderTokens: authorization.nextReservation.providerTokens,
          retryPolicy: prior.job.retryPolicy,
          evaluatedAt: now,
        },
      },
    );
  }
  if (
    executionGrantAuthorization === undefined &&
    (decision.retryMode === 'new-context' ||
      decision.retryMode === 'none' ||
      decision.retryMode === 'strategy-change')
  ) {
    throw workflowError(
      'PLAN_REVIEW_RETRY_STRATEGY_CHANGE_REQUIRED',
      'PlanReview retry requires a separately declared strategy change.',
      ExitCode.guard,
      { details: { reasonCode: decision.reasonCode } },
    );
  }
  const policyChanged =
    canonicalJson(prior.attempt.policySnapshot) !==
    canonicalJson(replacementPolicy);
  const retryMode: 'same-input' | 'execution-policy-change' | 'repair' =
    executionGrantAuthorization === undefined
      ? (decision.retryMode as
          'same-input' | 'execution-policy-change' | 'repair')
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
      failedRecord: failed,
      failedRequest,
    });
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
        ? loadProviderExecutionRepairContext(paths, failed, failedRequest)
        : undefined,
    grantId: executionGrantAuthorization?.grantId,
    environmentDigest: providerExecutionEnvironmentDigest(replacementRequest),
    createdAt: now,
  });
  if (
    replacement.job.jobId !== prior.job.jobId ||
    replacement.job.contextDigest !== prior.job.contextDigest ||
    replacement.attempt.attemptNumber !== failed.attempt + 1
  ) {
    throw workflowError(
      'PLAN_REVIEW_RETRY_EXECUTION_LINEAGE_INVALID',
      'PlanReview replacement changed stable semantic Job identity.',
      ExitCode.staleState,
    );
  }
  return authorization;
}

function providerRetryDecisionBinding(
  authorization: ReturnType<typeof authorizeAutomaticProviderRetry>,
): ProviderRetryDecisionBinding {
  return {
    schemaVersion: 1,
    kind: 'provider-retry-decision-binding',
    executionJobId: authorization.job.jobId,
    executionRevision: authorization.executionRevision,
    failedAttemptId: authorization.attempt.attemptId,
    evidenceDigest: authorization.evidenceDigest,
    evaluatedAt: authorization.evaluatedAt,
  };
}

function createPlanReviewReplacementReservationNode(
  reservation: PlanReviewReservation,
  previousReservationNode: EvidenceNode,
  input: PlanReviewRetryEnvelope,
  replacementRequest: ProviderInvocationRequest,
  attempt: number,
  retryDecision: ProviderRetryDecisionBinding,
  executionPolicySnapshot: ProviderExecutionPolicySnapshotCurrent,
): EvidenceNode {
  return createEvidenceNode({
    type: 'plan-review-request-reservation',
    nodeSchema: 'workflow.plan-review-request-reservation.v3',
    evaluator: 'workflow-propose.v1',
    policyDigest: PROPOSE_POLICY_DIGEST,
    exactInputDigests: {
      request: replacementRequest.requestDigest,
      manifest: replacementRequest.inputManifestDigest,
      subject: reservation.subject.subjectDigest,
      targetSnapshot: reservation.targetSnapshotNode.nodeId,
      previousRequest: previousReservationNode.nodeId,
      failure: input.failedInvocation.failureDigest,
      retryDecision: retryDecision.evidenceDigest,
      executionPolicySnapshot: sha256(canonicalJson(executionPolicySnapshot)),
    },
    semanticParentResultDigests: {
      authorization:
        previousReservationNode.semanticParentResultDigests.authorization,
      previousRequest: previousReservationNode.resultDigest,
    },
    provenanceParentNodeIds: {
      authorization:
        previousReservationNode.provenanceParentNodeIds.authorization,
      previousRequest: previousReservationNode.nodeId,
    },
    outputSchema: 'workflow.plan-review-request-reservation-output.v3',
    output: {
      investigationId: input.investigationId,
      changeId: input.changeId,
      planning: reservation.planning,
      subject: reservation.subject,
      assignment: reservation.assignment,
      author: reservation.author,
      materializationNode: reservation.materializationNode,
      targetSnapshotNode: reservation.targetSnapshotNode,
      manifest: reservation.manifest,
      request: replacementRequest,
      grantAuthorization: reservation.grantAuthorization,
      retry: {
        attempt,
        previousReservationNodeId: previousReservationNode.nodeId,
        failedInvocation: input.failedInvocation,
        retryDecision,
        executionPolicySnapshot,
      },
    },
    runtimeMetadata: {},
  });
}

function assertExactPlanReviewRetryReplay(
  paths: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  reservation: PlanReviewReservation,
  input: PlanReviewRetryEnvelope,
): void {
  if (
    reservation.retry === null ||
    reservation.retry.retryDecision === null ||
    reservation.retry.executionPolicySnapshot === null
  ) {
    throw workflowError(
      'PLAN_REVIEW_RETRY_DECISION_EVIDENCE_REQUIRED',
      'A historical PlanReview retry reservation without decision evidence cannot authorize provider work.',
      ExitCode.guard,
    );
  }
  const failed = readProviderInvocation(
    paths,
    input.failedInvocation.invocationId,
  );
  const failedRequest = readProviderInvocationRequest(
    paths,
    input.failedInvocation.invocationId,
  );
  const previousReservationNode = readEvidenceNode(
    paths,
    input.expectedReservationNodeId,
  );
  const expectedRequest = createPlanReviewReplacementRequest(
    input,
    failedRequest,
    {
      policyDigest: reservation.request.policyDigest,
      limits: reservation.request.limits,
    },
  );
  const expectedReservationNode = createPlanReviewReplacementReservationNode(
    reservation,
    previousReservationNode,
    input,
    expectedRequest,
    input.failedInvocation.attempt + 1,
    reservation.retry.retryDecision,
    reservation.retry.executionPolicySnapshot,
  );
  if (
    reservation.retry === null ||
    reservation.subject.subjectDigest !== input.subjectDigest ||
    reservation.subject.planningGenerationId !== input.planningGenerationId ||
    reservation.retry.previousReservationNodeId !==
      input.expectedReservationNodeId ||
    canonicalJson(reservation.retry.failedInvocation) !==
      canonicalJson(input.failedInvocation) ||
    failed.investigationId !== input.investigationId ||
    failed.changeId !== input.changeId ||
    failed.state !== 'failed' ||
    failed.failure === null ||
    failed.failure.kind !== 'retryable' ||
    failed.attempt !== input.failedInvocation.attempt ||
    failed.revision !== input.failedInvocation.revision ||
    failed.requestDigest !== input.failedInvocation.requestDigest ||
    failedRequest.requestDigest !== input.failedInvocation.requestDigest ||
    sha256(canonicalJson(failed.failure)) !==
      input.failedInvocation.failureDigest ||
    canonicalJson(reservation.request) !== canonicalJson(expectedRequest) ||
    canonicalJson(reservation.reservationNode) !==
      canonicalJson(expectedReservationNode)
  ) {
    throw planReviewRetryInputStale();
  }
}

function planReviewRetryInputStale() {
  return workflowError(
    'PLAN_REVIEW_RETRY_INPUT_STALE',
    'PlanReview retry input is not bound to the exact failed review attempt.',
    ExitCode.staleState,
  );
}

function dispatchPreparedPlanReview(
  cwd: string,
  output: ProposeOutput,
  options: ProposeResumeOptions,
): void {
  if (
    output.planReview?.state !== 'prepared' ||
    (!options.providerDriver && !options.providerDispatcher)
  ) {
    return;
  }
  dispatchMandatedProviderInvocation(
    cwd,
    output.planReview.invocationId,
    (runtime, request) => {
      if (options.providerDriver) {
        options.providerDriver({ paths: runtime, request });
      } else if (options.providerDispatcher) {
        options.providerDispatcher(cwd, request.invocationId);
      }
    },
  );
}

function resumePlanReview(
  cwd: string,
  input: PlanReviewProgressEnvelope,
  options: ProposeResumeOptions,
): ProposeOutput {
  const status = getProposeLifecycleStatus(cwd, input.investigationId);
  if (status.changeId !== input.changeId) {
    throw workflowError(
      'PROPOSE_INPUT_STALE',
      'PlanReview progress belongs to another investigation.',
      ExitCode.staleState,
    );
  }
  const context = loadInvestigationRuntimeContext(cwd);
  const reservation = readPlanReviewReservation(context.runtime, status);
  if (
    reservation === null ||
    reservation.subject.subjectDigest !== input.subjectDigest ||
    reservation.request.invocationId !== input.invocationId ||
    reservation.request.requestDigest !== input.requestDigest
  ) {
    throw workflowError(
      'PROPOSE_INPUT_STALE',
      'PlanReview progress is not bound to the current exact request.',
      ExitCode.staleState,
    );
  }
  let invocation = readProviderInvocation(
    context.runtime,
    reservation.request.invocationId,
  );
  if (invocation.state === 'prepared') {
    if (options.providerDriver || options.providerDispatcher) {
      dispatchMandatedProviderInvocation(
        cwd,
        reservation.request.invocationId,
        (runtime, request) => {
          if (options.providerDriver) {
            options.providerDriver({ paths: runtime, request });
          } else if (options.providerDispatcher) {
            options.providerDispatcher(cwd, request.invocationId);
          }
        },
      );
    }
    invocation = readProviderInvocation(
      context.runtime,
      reservation.request.invocationId,
    );
  }
  if (invocation.state !== 'succeeded' || invocation.result === null) {
    return getProposeStatus(cwd, status.investigationId);
  }
  const admitted = withInvestigationTransitionAuthority(
    context.lifecycleRuntime,
    status.changeId,
    (assertOwned) => {
      assertOwned();
      const lockedStatus = getProposeLifecycleStatus(
        cwd,
        input.investigationId,
      );
      const lockedContext = loadInvestigationRuntimeContext(cwd);
      if (lockedStatus.state === 'investigation-exempt') {
        assertCurrentExemptionContext(lockedContext, lockedStatus);
      }
      const lockedReservation = readPlanReviewReservation(
        lockedContext.runtime,
        lockedStatus,
      );
      if (
        lockedStatus.changeId !== input.changeId ||
        lockedReservation === null ||
        lockedReservation.subject.subjectDigest !== input.subjectDigest ||
        lockedReservation.request.invocationId !== input.invocationId ||
        lockedReservation.request.requestDigest !== input.requestDigest
      ) {
        throw workflowError(
          'PROPOSE_INPUT_STALE',
          'PlanReview progress changed before admission.',
          ExitCode.staleState,
        );
      }
      const lockedInvocation = readProviderInvocation(
        lockedContext.runtime,
        lockedReservation.request.invocationId,
      );
      if (
        lockedInvocation.state !== 'succeeded' ||
        lockedInvocation.result === null
      ) {
        return { outcome: 'pending' as const };
      }
      const tracked = materializePlanReviewResult(
        cwd,
        lockedStatus,
        lockedReservation,
        lockedInvocation.result,
        assertOwned,
        options.collaborationGrantValidation,
      );
      if ('reopenedInvestigation' in tracked) {
        return {
          outcome: 'reopened' as const,
          status: tracked.reopenedInvestigation,
        };
      }
      if ('blockedInvestigation' in tracked) {
        return {
          outcome: 'blocked' as const,
          status: tracked.blockedInvestigation,
        };
      }
      const review = readPlanReviewNode(tracked.reviewNode);
      if (review.findings.length > 0) {
        return {
          outcome: 'findings' as const,
          investigationId: lockedStatus.investigationId,
        };
      }
      return {
        outcome: 'complete' as const,
        output: commitCompletedPlanningUnderAuthority(
          cwd,
          lockedStatus,
          assertOwned,
        ),
      };
    },
  );
  if (admitted.outcome === 'pending') {
    return getProposeStatus(cwd, status.investigationId);
  }
  if (admitted.outcome === 'reopened') {
    return renderProposeOutputWithPlanningAuthority(
      cwd,
      admitted.status,
      null,
      options.collaborationGrantValidation,
    );
  }
  if (admitted.outcome === 'blocked') {
    return renderProposeOutputWithPlanningAuthority(
      cwd,
      admitted.status,
      null,
      options.collaborationGrantValidation,
    );
  }
  if (admitted.outcome === 'findings') {
    return getProposeStatus(cwd, admitted.investigationId);
  }
  return admitted.output;
}

function materializePlanReviewResult(
  cwd: string,
  status: ProposeLifecycleStatus,
  reservation: PlanReviewReservation,
  result: ProviderProcessResult,
  assertOwned: HeldChangeTransitionAuthority,
  grantValidation?: ProposeResumeOptions['collaborationGrantValidation'],
):
  | {
      nodes: EvidenceNode[];
      reviewNode: EvidenceNode;
      dispositionNode: EvidenceNode | null;
      roleResult: AdmittedRoleResult;
    }
  | {
      reopenedInvestigation: InvestigationStatus;
    }
  | {
      blockedInvestigation: InvestigationStatus;
    } {
  const context = loadInvestigationRuntimeContext(cwd);
  const existing = readTrackedPlanReview(
    context.git.repositoryRoot,
    status.changeId,
  );
  if (existing !== null) {
    return existing;
  }
  if (result.runtimeObservation === null) {
    throw workflowError(
      'PLAN_REVIEW_RUNTIME_ASSURANCE_REQUIRED',
      'An ordinary provider PlanReview requires a fixed-runner observation.',
      ExitCode.verification,
    );
  }
  const submission = result.output as PlanReviewSubmission;
  const providerResultNode = createPlanReviewProviderResultNode({
    subject: reservation.subject,
    assignment: reservation.assignment,
    submission,
    providerPolicyDigest: reservation.request.policyDigest,
    targetSnapshotNode: reservation.targetSnapshotNode,
    runtimeAssurance: {
      assurance: result.runtimeObservation.assurance,
      projectionDigest: result.runtimeObservation.projection.beforeDigest,
      sameUserProcessConfined:
        result.runtimeObservation.sameUserProcessConfined,
      residuals: result.runtimeObservation.residuals,
      executableSha256: result.runtimeObservation.executable.sha256,
    },
  });
  const reviewNode = createPlanReviewNode({
    subject: reservation.subject,
    assignment: reservation.assignment,
    providerResultNode,
    submission,
  });
  const review = readPlanReviewNode(reviewNode);
  let reviewerRebuild: RebuiltInvestigation | null = null;
  let reviewerResolution: ReturnType<
    typeof inspectReviewerTermResolutionAuthorization
  > = { outcome: 'none', resolutionNodeId: null };
  let novelReviewerTerms = review.proposedTerms;
  let reviewerReopenPolicy: ReturnType<typeof decideReviewerTermReopen> =
    review.proposedTerms.length === 0 ? 'no-novel-terms' : 'automatic-reopen';
  if (
    review.proposedTerms.length > 0 &&
    status.state !== 'investigation-exempt'
  ) {
    reviewerRebuild = rebuildInvestigation(
      cwd,
      status.investigationId,
      'consume',
      grantValidation,
      assertOwned,
    );
    const admittedContributions = reviewerRebuild.contributionNodes.map(
      (node) => structuredClone(node.output),
    ) as InvestigationTermContribution[];
    novelReviewerTerms = deriveReviewerTermDelta({
      existingContributions: admittedContributions,
      proposedTerms: review.proposedTerms,
      engineOwnedReviewerReferences: reviewerRebuild.reviewerTermSourceNodeIds,
    }).novelTerms;
    if (reviewerRebuild.reviewerTermReopenCount >= 2) {
      reviewerResolution = inspectReviewerTermResolutionAuthorization(
        cwd,
        status.investigationId,
        reviewNode.resultDigest,
      );
    }
    reviewerReopenPolicy = decideReviewerTermReopen({
      usedReopens: reviewerRebuild.reviewerTermReopenCount,
      novelTermCount: novelReviewerTerms.length,
      humanResolution: reviewerResolution,
    });
    if (reviewerReopenPolicy === 'human-action-required') {
      return {
        blockedInvestigation: blockInvestigationForReviewerTermsUnderAuthority(
          cwd,
          status.changeId,
          status.investigationId,
          {
            expectedRevision: status.revision,
            pendingReviewDigest: reviewNode.resultDigest,
            usedReopens: reviewerRebuild.reviewerTermReopenCount,
            proposedTermCount: novelReviewerTerms.length,
          },
          assertOwned,
        ),
      };
    }
  }
  const content = {
    kind: 'plan-review' as const,
    nodeId: reviewNode.nodeId,
    resultDigest: reviewNode.resultDigest,
    outputSchema: PLAN_REVIEW_OUTPUT_SCHEMA,
    evaluator: reviewNode.evaluator,
    policyDigest: reviewNode.policyDigest,
    contentDigest: reviewNode.resultDigest,
    current: true as const,
  };
  let grantUse: CollaborationGrantUseProjection | null = null;
  let grantAdmission: NonNullable<
    Parameters<typeof admitRoleResult>[0]['grantValidation']
  > | null = null;
  if ('grantId' in reservation.assignment) {
    if (
      reservation.grantAuthorization === null ||
      reservation.grantAuthorization.grantId !== reservation.assignment.grantId
    ) {
      throw workflowError(
        'COLLABORATION_GRANT_ADMISSION_REQUIRED',
        'A granted PlanReview requires its exact durable grant authorization.',
        ExitCode.guard,
      );
    }
    const policy = loadMaintainerPolicyAtCommit(
      context.git.repositoryRoot,
      reservation.grantAuthorization.expectedBinding.baselineCommit,
    );
    const verifier =
      grantValidation?.verifier ??
      createInteractiveSshSigner(context.git.repositoryRoot, policy);
    const now = grantValidation?.now ?? new Date();
    const consumed = consumeCollaborationGrantUnderLifecycleLock(
      context.git.gitCommonDirectory,
      reservation.grantAuthorization.grantId,
      {
        transitionDigest: reservation.grantAuthorization.transitionDigest,
        assignment: reservation.assignment,
        contentAdmission: {
          kind: content.kind,
          nodeId: content.nodeId,
          resultDigest: content.resultDigest,
          current: true,
        },
        now,
      },
      assertOwned,
    );
    if (!consumed.use) {
      throw workflowError(
        'COLLABORATION_GRANT_ADMISSION_REQUIRED',
        'The exact PlanReview collaboration grant use was not durably consumed.',
        ExitCode.staleState,
      );
    }
    grantUse = consumed.use;
    grantAdmission = {
      now,
      expectedBinding: reservation.grantAuthorization.expectedBinding,
      policy,
      verifier,
      transitionDigest: reservation.grantAuthorization.transitionDigest,
    };
  }
  const roleResult = admitRoleResult({
    assignment: reservation.assignment,
    author: reservation.author,
    participant:
      'grantId' in reservation.assignment
        ? reservation.assignment.participant
        : {
            providerId: reservation.assignment.providerId,
            sessionId: reservation.assignment.sessionId,
            principalId: null,
            identityAssurance: 'adapter-assigned',
            engineSpawned: true,
          },
    content,
    providerInvocation: {
      invocationId: reservation.request.invocationId,
      requestDigest: reservation.request.requestDigest,
      outputDigest: result.outputDigest,
      providerId: reservation.assignment.providerId,
      sessionId: reservation.assignment.sessionId,
      targetDigest: reservation.assignment.targetDigest,
      engineSpawned: true,
    },
    grantUse,
    grantValidation: grantAdmission,
  });
  if (
    review.proposedTerms.length > 0 &&
    novelReviewerTerms.length > 0 &&
    reviewerReopenPolicy !== 'human-close-input'
  ) {
    if (status.state === 'investigation-exempt') {
      retireCurrentProposeExemptionSession(
        loadInvestigationRuntimeContext(cwd).runtime,
        status,
        assertOwned,
      );
      throw workflowError(
        'INVESTIGATION_EXEMPTION_REVIEWER_TERMS_REQUIRED',
        'Reviewer terms invalidate the zero-scan exemption and require an ordinary investigation revision.',
        ExitCode.guard,
      );
    }
    const rebuilt =
      reviewerRebuild ??
      rebuildInvestigation(
        cwd,
        status.investigationId,
        'consume',
        grantValidation,
        assertOwned,
      );
    const existingContributions = rebuilt.contributionNodes.map((node) =>
      structuredClone(node.output),
    ) as InvestigationTermContribution[];
    const projection = projectPlanReviewTerms({
      validationInput: {
        reviewNode,
        dispositionNode: null,
        subject: reservation.planning.subject,
        generation: reservation.planning.generation,
        target: reservation.planning.target,
        expectedReviewPolicyDigest:
          reservation.planning.policies.reviewPolicyDigest,
        requiredIndependence: 'provider-independent',
        independenceAuthorization: {
          kind: 'admitted-role-result',
          roleResult,
        },
        repositoryEvidence: resolvePlanReviewRepositoryEvidence(
          context.git.repositoryRoot,
          reservation.planning.generation.investigationBaseline.tree,
          reviewNode,
          reservation.manifest.planningTarget,
        ),
        planningTarget: reservation.manifest.planningTarget,
        planningEvidence: resolvePlanReviewPlanningEvidence(
          context.git.repositoryRoot,
          reservation.manifest.planningTarget,
          reviewNode,
        ),
      },
      existingContributions,
      engineOwnedReviewerReferences: rebuilt.reviewerTermSourceNodeIds,
    });
    if (projection.preview.outcome !== 'ready') {
      throw workflowError(
        'INVESTIGATION_TERM_NARROWING_REQUIRED',
        'Reviewer-proposed terms exceed the fixed investigation budgets.',
        ExitCode.guard,
        { details: { violations: projection.preview.violations } },
      );
    }
    const sourceNode = createReviewerTermSourceNode({
      status,
      providerResultNode,
      reviewNode,
      roleResult,
      terms: novelReviewerTerms,
      priorGroupDispositions: rebuilt.session.milestones.groupDispositions!,
      priorWhyAnswers: rebuilt.session.milestones.whyAnswers!,
      previousReviewerTermSourceNode: rebuilt.reviewerTermSourceNode,
      authorizationResolutionNodeId:
        reviewerResolution.outcome === 'resume'
          ? reviewerResolution.resolutionNodeId
          : null,
    });
    for (const node of [providerResultNode, reviewNode, sourceNode]) {
      writeEvidenceNode(context.runtime, node);
    }
    return {
      reopenedInvestigation: reopenInvestigationForReviewerTermsUnderAuthority(
        cwd,
        status.changeId,
        status.investigationId,
        {
          expectedRevision: status.revision,
          sourceNodeId: sourceNode.nodeId,
          usedReopens: rebuilt.reviewerTermReopenCount,
          pendingReviewDigest: reviewNode.resultDigest,
          authorizationResolutionNodeId:
            reviewerResolution.outcome === 'resume'
              ? reviewerResolution.resolutionNodeId
              : null,
        },
        assertOwned,
      ),
    };
  }
  if (
    reviewerReopenPolicy === 'human-close-input' &&
    reviewerResolution.outcome === 'close-input'
  ) {
    acknowledgeReviewerTermInputClosureUnderAuthority(
      cwd,
      status.changeId,
      status.investigationId,
      {
        expectedRevision: status.revision,
        pendingReviewDigest: reviewNode.resultDigest,
        authorizationResolutionNodeId: reviewerResolution.resolutionNodeId,
      },
      assertOwned,
    );
  }
  const tracked = {
    nodes: [reservation.targetSnapshotNode, providerResultNode, reviewNode],
    reviewNode,
    dispositionNode: null,
    roleResult,
  };
  if (status.state === 'investigation-exempt') {
    assertCurrentExemptionContext(loadInvestigationRuntimeContext(cwd), status);
  }
  writeTrackedPlanReview(context.git.repositoryRoot, status.changeId, {
    nodes: tracked.nodes,
    roleResult,
    dispositionNode: null,
  });
  assertOwned();
  return tracked;
}

function completePlanReviewDispositions(
  cwd: string,
  input: PlanReviewDispositionsEnvelope,
): ProposeOutput {
  const initialContext = loadInvestigationRuntimeContext(cwd);
  return withInvestigationTransitionAuthority(
    initialContext.lifecycleRuntime,
    input.changeId,
    (assertOwned) => {
      assertOwned();
      const status = getProposeLifecycleStatus(cwd, input.investigationId);
      const context = loadInvestigationRuntimeContext(cwd);
      if (status.state === 'investigation-exempt') {
        assertCurrentExemptionContext(context, status);
      }
      const reservation = readPlanReviewReservation(context.runtime, status);
      const tracked = readTrackedPlanReview(
        context.git.repositoryRoot,
        status.changeId,
      );
      if (
        status.changeId !== input.changeId ||
        reservation === null ||
        reservation.subject.subjectDigest !== input.subjectDigest ||
        tracked === null ||
        tracked.reviewNode.nodeId !== input.reviewNodeId ||
        tracked.reviewNode.resultDigest !== input.reviewResultDigest ||
        tracked.dispositionNode !== null
      ) {
        throw workflowError(
          'PROPOSE_INPUT_STALE',
          'PlanReview dispositions are not bound to the current review.',
          ExitCode.staleState,
        );
      }
      const dispositionNode = createPlanReviewDispositionNode({
        reviewNode: tracked.reviewNode,
        policyDigest: reservation.subject.reviewPolicyDigest,
        dispositions: input.dispositions,
      });
      if (status.state === 'investigation-exempt') {
        assertCurrentExemptionContext(
          loadInvestigationRuntimeContext(cwd),
          status,
        );
      }
      writeTrackedPlanReview(context.git.repositoryRoot, status.changeId, {
        nodes: tracked.nodes,
        roleResult: tracked.roleResult,
        dispositionNode,
      });
      assertOwned();
      return commitCompletedPlanningUnderAuthority(cwd, status, assertOwned);
    },
  );
}

function writeTrackedPlanReview(
  repositoryRoot: string,
  changeId: string,
  input: {
    nodes: EvidenceNode[];
    roleResult: AdmittedRoleResult;
    dispositionNode: EvidenceNode | null;
  },
): void {
  const reviewNode = input.nodes.find(({ type }) => type === 'plan-review');
  if (!reviewNode) {
    throw workflowError(
      'PLAN_REVIEW_ARTIFACT_INVALID',
      'PlanReview artifact has no review node.',
      ExitCode.verification,
    );
  }
  const nodes = uniqueNodes([
    ...input.nodes,
    ...(input.dispositionNode ? [input.dispositionNode] : []),
  ]);
  const artifact = parsePlanReviewArtifact(
    {
      schemaVersion: 1,
      kind: 'plan-review-artifact',
      changeId,
      nodes,
      currentRefs: {
        planReview: reviewNode.nodeId,
        ...(input.dispositionNode
          ? { planReviewDisposition: input.dispositionNode.nodeId }
          : {}),
      },
      roleResults: [input.roleResult],
    },
    changeId,
  );
  const target = path.join(
    repositoryRoot,
    loadInvestigationRuntimeContext(repositoryRoot).config.changeRoot,
    changeId,
    'plan-review.json',
  );
  const bytes = `${canonicalJson(artifact)}\n`;
  if (fs.existsSync(target)) {
    const current = fs.readFileSync(target, 'utf8');
    if (current === bytes) {
      return;
    }
    replaceTextAtomic(target, bytes, { allowCreate: false });
    return;
  }
  replaceTextAtomic(target, bytes, { allowCreate: true, defaultMode: 0o644 });
}

function commitCompletedPlanningUnderAuthority(
  cwd: string,
  status: ProposeLifecycleStatus,
  assertOwned: HeldChangeTransitionAuthority,
): ProposeOutput {
  assertOwned();
  const before = getProposeStatusInternal(
    cwd,
    status.investigationId,
    undefined,
    assertOwned,
  );
  if (status.state === 'investigation-exempt') {
    const context = loadInvestigationRuntimeContext(cwd);
    assertCurrentExemptionContext(context, status);
    retireCurrentProposeExemptionSession(context.runtime, status, assertOwned);
  }
  const planningTransition = commitPlanningTransitionUnderAuthority(
    cwd,
    status.changeId,
    assertOwned,
  );
  return {
    ...before,
    state: 'planning-complete',
    nextAction: 'planning-complete',
    inputSchema: null,
    planningTransition,
  };
}

function getProposeLifecycleStatus(
  cwd: string,
  investigationId: string,
): ProposeLifecycleStatus {
  if (isProposeExemptionInvestigationId(investigationId)) {
    const context = loadInvestigationRuntimeContext(cwd);
    return readProposeExemptionSession(context.runtime, investigationId);
  }
  return getInvestigationStatus(cwd, investigationId);
}

function getExemptionProposeStatus(
  cwd: string,
  investigationId: string,
): ExemptionProposeOutput {
  const context = loadInvestigationRuntimeContext(cwd);
  const session = readProposeExemptionSession(context.runtime, investigationId);
  assertCurrentExemptionContext(context, session);
  return renderExemptionProposeOutput(
    cwd,
    session,
    prepareExemptionPlanningScaffold(cwd, session, true, true, false),
  );
}

function renderExemptionProposeOutput(
  cwd: string,
  session: ProposeExemptionSession,
  knownScaffold?: ReturnType<typeof prepareExemptionPlanningScaffold>,
  knownMaterializedArtifacts?: Record<string, string>,
): ExemptionProposeOutput {
  const context = loadInvestigationRuntimeContext(cwd);
  const receipt = readExemptionPlanningMaterializationReceipt(
    context.runtime,
    session,
  );
  if (receipt === null) {
    return exemptionAwaitingPlanningOutput(
      session,
      knownScaffold ?? prepareExemptionPlanningScaffold(cwd, session),
    );
  }
  const scaffold =
    knownScaffold ?? prepareExemptionPlanningScaffold(cwd, session, true, true);
  const materializedArtifacts =
    knownMaterializedArtifacts ??
    readMaterializedExemptionPlanningArtifacts(
      cwd,
      session,
      scaffold.changeDirectory,
    );
  return renderMaterializedProposeOutput(
    cwd,
    session,
    {
      outcome: 'resolved',
      providerId: session.actor.providerId,
      assurance: session.actor.assurance,
      signals: session.signals,
    },
    session.createdAt.slice(0, 10),
    {
      termSources: { engine: 0, main: 0, reviewer: 0, survey: 0 },
      groups: [],
      fullBlobManifest: [],
      authoredInstructions: scaffold.instructions,
    },
    materializedArtifacts,
  ) as ExemptionProposeOutput;
}

export function getProposeStatus(
  cwd: string,
  requestedInvestigationId: string,
  grantValidation?: ProposeResumeOptions['collaborationGrantValidation'],
): ProposeOutput {
  return getProposeStatusInternal(
    cwd,
    requestedInvestigationId,
    grantValidation,
  );
}

function getProposeStatusInternal(
  cwd: string,
  requestedInvestigationId: string,
  grantValidation?: ProposeResumeOptions['collaborationGrantValidation'],
  assertOwned?: () => void,
): ProposeOutput {
  if (isProposeExemptionInvestigationId(requestedInvestigationId)) {
    return getExemptionProposeStatus(cwd, requestedInvestigationId);
  }
  const status = getInvestigationStatus(cwd, requestedInvestigationId);
  assertOwned?.();
  const rebuilt = rebuildInvestigation(
    cwd,
    status.investigationId,
    'replay-consumed',
    grantValidation,
    assertOwned,
  );
  const context = loadInvestigationRuntimeContext(cwd);
  const request = readProviderInvocationRequest(
    context.runtime,
    status.providerInvocationId,
  );
  const authorization = readProposeAuthorization(context.runtime, request);
  const actorResolution: ProposeOutput['actorResolution'] = {
    outcome: 'resolved',
    providerId: authorization.actor.providerId,
    assurance: authorization.actor.assurance,
    signals: authorization.signals,
  };
  if (status.state !== 'investigation-sealed') {
    return renderProposeOutput(
      cwd,
      status,
      'replay-consumed',
      actorResolution,
      undefined,
      grantValidation,
      assertOwned,
    );
  }

  const scaffold = {
    changeDirectory: path.join(
      context.git.repositoryRoot,
      context.config.changeRoot,
      status.changeId,
    ),
    investigationBytes: '',
  };
  const materialized = readMaterializedPlanningArtifacts(
    cwd,
    status,
    rebuilt,
    scaffold,
  );
  const createdDate = rebuilt.session.createdAt.slice(0, 10);
  if (materialized === null) {
    return {
      schemaVersion: 1,
      kind: 'workflow-propose',
      changeId: status.changeId,
      state: 'awaiting-planning-contribution',
      nextAction: 'submit-planning-contribution',
      investigation: status,
      createdDate,
      actorResolution,
      inputSchema: planningContributionSchema(status),
      work: workFromRebuilt(rebuilt, []),
      materializedArtifacts: null,
      planReview: null,
      planningTransition: null,
      semanticReuse: rebuilt.reuseCoverage,
    };
  }
  return renderMaterializedProposeOutput(
    cwd,
    status,
    actorResolution,
    createdDate,
    workFromRebuilt(rebuilt, []),
    materialized,
    rebuilt.reuseCoverage,
  );
}

function renderProposeOutputWithPlanningAuthority(
  cwd: string,
  status: InvestigationStatus,
  actorResolution: ProposeOutput['actorResolution'] = null,
  grantValidation?: ProposeResumeOptions['collaborationGrantValidation'],
): ProposeOutput {
  if (status.state !== 'investigation-sealed') {
    return renderProposeOutput(
      cwd,
      status,
      'consume',
      actorResolution,
      undefined,
      grantValidation,
    );
  }
  const initialContext = loadInvestigationRuntimeContext(cwd);
  return withInvestigationTransitionAuthority(
    initialContext.lifecycleRuntime,
    status.changeId,
    (assertOwned) => {
      assertOwned();
      const current = getInvestigationStatus(cwd, status.investigationId);
      if (
        current.revision !== status.revision ||
        current.changeId !== status.changeId ||
        canonicalJson(current.baseline) !== canonicalJson(status.baseline)
      ) {
        throw workflowError(
          'PROPOSE_INPUT_STALE',
          'Investigation changed before planning scaffold materialization.',
          ExitCode.staleState,
        );
      }
      const result = renderProposeOutput(
        cwd,
        current,
        'consume',
        actorResolution,
        undefined,
        grantValidation,
        assertOwned,
      );
      assertOwned();
      return result;
    },
  );
}

function renderProposeOutput(
  cwd: string,
  status: InvestigationStatus,
  grantAccess: CollaborationGrantAccessMode,
  actorResolution: ProposeOutput['actorResolution'] = null,
  knownMaterializedArtifacts?: Record<string, string>,
  grantValidation?: ProposeResumeOptions['collaborationGrantValidation'],
  assertOwned?: () => void,
): ProposeOutput {
  const rebuilt = rebuildInvestigation(
    cwd,
    status.investigationId,
    grantAccess,
    grantValidation,
    assertOwned,
  );
  const createdDate = rebuilt.session.createdAt.slice(0, 10);
  if (status.state === 'investigation-sealed') {
    const context = loadInvestigationRuntimeContext(cwd);
    const receiptLookup = {
      changeDirectory: path.join(
        context.git.repositoryRoot,
        context.config.changeRoot,
        status.changeId,
      ),
      investigationBytes: '',
      instructions: [] as ProposeWork['authoredInstructions'],
    };
    const materialized =
      knownMaterializedArtifacts ??
      readMaterializedPlanningArtifacts(cwd, status, rebuilt, receiptLookup);
    if (materialized !== null) {
      return renderMaterializedProposeOutput(
        cwd,
        status,
        actorResolution,
        createdDate,
        workFromRebuilt(rebuilt, receiptLookup.instructions),
        materialized,
        rebuilt.reuseCoverage,
      );
    }
    const scaffold = preparePlanningScaffold(cwd, status, rebuilt, createdDate);
    return {
      schemaVersion: 1,
      kind: 'workflow-propose',
      changeId: status.changeId,
      state: 'awaiting-planning-contribution',
      nextAction: 'submit-planning-contribution',
      investigation: status,
      createdDate,
      actorResolution,
      inputSchema: planningContributionSchema(status),
      work: workFromRebuilt(rebuilt, scaffold.instructions),
      materializedArtifacts: null,
      planReview: null,
      planningTransition: null,
      semanticReuse: rebuilt.reuseCoverage,
    };
  }

  return {
    schemaVersion: 1,
    kind: 'workflow-propose',
    changeId: status.changeId,
    state: status.state,
    nextAction: status.nextAction,
    investigation: status,
    createdDate,
    actorResolution,
    inputSchema: inputSchemaForStatus(cwd, status),
    work: workFromRebuilt(rebuilt, []),
    materializedArtifacts: null,
    planReview: null,
    planningTransition: null,
    semanticReuse: rebuilt.reuseCoverage,
  };
}

function renderMaterializedProposeOutput(
  cwd: string,
  status: ProposeLifecycleStatus,
  actorResolution: ProposeOutput['actorResolution'],
  createdDate: string,
  work: ProposeWork,
  materializedArtifacts: Record<string, string>,
  semanticReuse: ReuseCoverageRecord | null = null,
): ProposeOutput {
  const context = loadInvestigationRuntimeContext(cwd);
  const reservation = readPlanReviewReservation(context.runtime, status);
  if (reservation === null) {
    const grantRequirement = readPlanReviewGrantRequirement(
      context.runtime,
      status,
    );
    return {
      schemaVersion: 1,
      kind: 'workflow-propose',
      changeId: status.changeId,
      state:
        grantRequirement === null
          ? 'plan-review-required'
          : 'human-action-required',
      nextAction:
        grantRequirement === null ? 'obtain-plan-review' : 'human-action',
      investigation: status,
      createdDate,
      actorResolution,
      inputSchema:
        grantRequirement === null
          ? null
          : {
              schemaVersion: 1,
              kind: 'collaboration-grant-selection',
              lifecyclePhase: 'plan-review',
              conflictingRole: 'plan-reviewer',
              subjectDigest: grantRequirement.subject.subjectDigest,
              grantRequest: grantRequirement.grantRequest,
              allowedDegradedForms:
                grantRequirement.grantRequest === null
                  ? ['caller-supplied', 'direct-human-review']
                  : ['same-provider-fresh-session'],
              resumeOption: '--grant <grant-id>',
            },
      work,
      materializedArtifacts,
      planReview: null,
      planningTransition: null,
      semanticReuse,
    };
  }
  if (
    !providerInvocationExists(context.runtime, reservation.request.invocationId)
  ) {
    throw workflowError(
      'PLAN_REVIEW_INVOCATION_MISSING',
      'Plan-review status cannot repair a missing provider invocation.',
      ExitCode.staleState,
    );
  }
  const invocation = readProviderInvocation(
    context.runtime,
    reservation.request.invocationId,
  );
  const trackedReview = readTrackedPlanReview(
    context.git.repositoryRoot,
    status.changeId,
  );
  const planReview: ProposePlanReviewStatus = {
    subjectDigest: reservation.subject.subjectDigest,
    planningGenerationId: reservation.subject.planningGenerationId,
    invocationId: reservation.request.invocationId,
    requestDigest: reservation.request.requestDigest,
    providerId: reservation.request.providerId,
    state: invocation.state,
    failure: invocation.failure,
    reviewNodeId: trackedReview?.reviewNode.nodeId ?? null,
    reviewResultDigest: trackedReview?.reviewNode.resultDigest ?? null,
  };
  if (invocation.state === 'failed') {
    const retryable = invocation.failure?.kind === 'retryable';
    return {
      schemaVersion: 1,
      kind: 'workflow-propose',
      changeId: status.changeId,
      state: retryable ? 'waiting-for-plan-review' : 'human-action-required',
      nextAction: retryable ? 'retry-plan-review' : 'human-action',
      investigation: status,
      createdDate,
      actorResolution,
      inputSchema: retryable
        ? {
            schemaVersion: 1,
            kind: 'plan-review-retry',
            binding: {
              investigationId: status.investigationId,
              changeId: status.changeId,
              expectedRevision: status.revision,
              baseline: status.baseline,
              subjectDigest: reservation.subject.subjectDigest,
              planningGenerationId: reservation.subject.planningGenerationId,
              expectedReservationNodeId: reservation.reservationNode.nodeId,
              failedInvocation: {
                invocationId: invocation.invocationId,
                attempt: invocation.attempt,
                revision: invocation.revision,
                requestDigest: invocation.requestDigest,
                failureDigest: sha256(canonicalJson(invocation.failure)),
              },
            },
            requiredAcknowledgement: {
              acknowledgeProviderCost: true,
            },
          }
        : null,
      work,
      materializedArtifacts,
      planReview,
      planningTransition: null,
      semanticReuse,
    };
  }
  if (trackedReview !== null) {
    const review = readPlanReviewNode(trackedReview.reviewNode);
    if (review.findings.length > 0 && trackedReview.dispositionNode === null) {
      return {
        schemaVersion: 1,
        kind: 'workflow-propose',
        changeId: status.changeId,
        state: 'awaiting-challenge-dispositions',
        nextAction: 'submit-challenge-dispositions',
        investigation: status,
        createdDate,
        actorResolution,
        inputSchema: planReviewDispositionSchema(status, review),
        work,
        materializedArtifacts,
        planReview,
        planningTransition: null,
        semanticReuse: null,
      };
    }
  }
  return {
    schemaVersion: 1,
    kind: 'workflow-propose',
    changeId: status.changeId,
    state: 'waiting-for-plan-review',
    nextAction:
      invocation.state === 'succeeded'
        ? 'resume-plan-review'
        : 'wait-for-plan-review',
    investigation: status,
    createdDate,
    actorResolution,
    inputSchema: planReviewProgressSchema(status, reservation),
    work,
    materializedArtifacts,
    planReview,
    planningTransition: null,
    semanticReuse: null,
  };
}

function readTrackedPlanReview(
  repositoryRoot: string,
  changeId: string,
): {
  nodes: EvidenceNode[];
  reviewNode: EvidenceNode;
  dispositionNode: EvidenceNode | null;
  roleResult: AdmittedRoleResult;
} | null {
  const context = loadInvestigationRuntimeContext(repositoryRoot);
  const reviewPath = path.join(
    repositoryRoot,
    context.config.changeRoot,
    changeId,
    'plan-review.json',
  );
  if (!fs.existsSync(reviewPath)) {
    return null;
  }
  const artifact = parsePlanReviewArtifact(
    JSON.parse(fs.readFileSync(reviewPath, 'utf8')),
    changeId,
  );
  const reviewNodeId = artifact.currentRefs.planReview;
  const reviewNodes = artifact.nodes.filter(
    ({ nodeId }) => nodeId === reviewNodeId,
  );
  const roleResults = (artifact.roleResults ?? []).filter(
    (value) =>
      isRecord(value) &&
      isRecord(value.content) &&
      value.content.nodeId === reviewNodeId,
  );
  if (reviewNodes.length !== 1 || roleResults.length !== 1) {
    throw workflowError(
      'PLAN_REVIEW_ARTIFACT_STALE',
      'Tracked PlanReview does not select one admitted review result.',
      ExitCode.staleState,
    );
  }
  const dispositionId = artifact.currentRefs.planReviewDisposition;
  const dispositionNode = dispositionId
    ? (artifact.nodes.find(({ nodeId }) => nodeId === dispositionId) ?? null)
    : null;
  if (dispositionId && dispositionNode === null) {
    throw workflowError(
      'PLAN_REVIEW_ARTIFACT_STALE',
      'Tracked PlanReview disposition is unavailable.',
      ExitCode.staleState,
    );
  }
  if (dispositionNode !== null) {
    readPlanReviewDispositionNode(dispositionNode);
  }
  return {
    nodes: artifact.nodes,
    reviewNode: reviewNodes[0]!,
    dispositionNode,
    roleResult: roleResults[0] as unknown as AdmittedRoleResult,
  };
}

function planReviewProgressSchema(
  status: ProposeLifecycleStatus,
  reservation: PlanReviewReservation,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: 'plan-review-progress',
    required: {
      investigationId: status.investigationId,
      changeId: status.changeId,
      subjectDigest: reservation.subject.subjectDigest,
      invocationId: reservation.request.invocationId,
      requestDigest: reservation.request.requestDigest,
    },
  };
}

function planReviewDispositionSchema(
  status: ProposeLifecycleStatus,
  review: ReturnType<typeof readPlanReviewNode>,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: 'plan-review-dispositions',
    required: {
      investigationId: status.investigationId,
      changeId: status.changeId,
      subjectDigest: review.subjectDigest,
      reviewNodeId: review.nodeId,
      reviewResultDigest: review.resultDigest,
      challengeIds: review.findings.map(({ findingId }) => findingId),
    },
  };
}

type CollaborationGrantAccessMode = 'consume' | 'replay-consumed';

function rebuildInvestigation(
  cwd: string,
  investigationId: string,
  grantAccess: CollaborationGrantAccessMode,
  grantValidation?: ProposeResumeOptions['collaborationGrantValidation'],
  assertOwned?: () => void,
): RebuiltInvestigation {
  const context = loadInvestigationRuntimeContext(cwd);
  const session = readInvestigationSession(context.runtime, investigationId);
  const providerRequest = readProviderInvocationRequest(
    context.runtime,
    session.currentBlindInvocationId,
  );
  const authorizationNode = readEvidenceNode(
    context.runtime,
    providerRequest.authorizationNodeId,
  );
  const authorization = readProposeAuthorization(
    context.runtime,
    providerRequest,
  );
  const manifest = readBlindSurveyManifest(
    context.runtime,
    session.currentBlindInvocationId,
  );
  const intent = manifest.normalizedIntent;
  const changedPaths = derivePinnedDiffPathFacts({
    repositoryRoot: context.git.repositoryRoot,
    baseCommit: authorization.protectedBase.commit,
    targetCommit: session.baseline.head,
  });
  const reviewedRelationships = deriveReviewedAssetRelationships();
  const reviewedCounterparts = deriveReviewedCounterpartFacts(
    intent,
    changedPaths,
    reviewedRelationships,
  );
  const floor = deriveEngineFloor({
    explicitPaths: intent.explicitPaths,
    symbols: intent.explicitSymbols,
    configKeys: intent.explicitConfigKeys,
    transformations: intent.renamePairs.flatMap((pair, index) => [
      {
        kind: 'literal-content' as const,
        before: pair.from,
        after: pair.to,
        reference: `intent.renamePairs[${index}]`,
      },
    ]),
    changedPaths,
    reviewedCounterparts,
  });
  const emptyCounts: InvestigationTermRawCounts = {
    engine: floor.outcome === 'derived' ? floor.terms.length : 0,
    main: 0,
    survey: 0,
    reviewer: 0,
  };
  if (
    session.milestones.mainTerms === null ||
    session.milestones.blindResult === null
  ) {
    return emptyRebuilt(
      session,
      intent,
      floor,
      emptyCounts,
      authorizationNode,
      authorization.legacyMigration,
    );
  }
  const snapshot = readPinnedTrackedTree({
    repositoryRoot: context.git.repositoryRoot,
    treeOid: session.baseline.tree,
  });
  const mutationRules = deriveReviewedMutationRules(snapshot);

  const invocation = readProviderInvocation(
    context.runtime,
    session.milestones.blindResult.invocationId,
  );
  if (invocation.state !== 'succeeded' || invocation.result === null) {
    throw workflowError(
      'PROVIDER_RESULT_NOT_AVAILABLE',
      'Published blind survey result is unavailable.',
      ExitCode.staleState,
    );
  }
  const blindOutput = assertBlindOutput(invocation.result.output);
  const reviewerSource = readReviewerTermSource(
    context.runtime,
    session.milestones.reviewerTermSourceNodeId,
    session,
  );
  const main = session.milestones.mainTerms.envelope;
  if (main.kind !== 'main-terms') {
    throw workflowError(
      'INVESTIGATION_CHECKPOINT_INVALID',
      'Stored main term checkpoint is malformed.',
      ExitCode.staleState,
    );
  }
  const contributions: InvestigationTermContribution[] = [
    ...(floor.outcome === 'derived'
      ? [
          {
            source: 'engine' as const,
            reference: `engine-floor:${session.intentDigest}`,
            terms: floor.terms.map(({ kind, value }) => ({ kind, value })),
          },
        ]
      : []),
    {
      source: 'main',
      reference: main.payload.reference,
      terms: main.payload.terms,
    },
    {
      source: 'survey',
      reference: blindOutput.reference,
      terms: blindOutput.terms,
    },
    ...(reviewerSource === null
      ? []
      : [
          {
            source: 'reviewer' as const,
            reference: reviewerSource.sourceNode.nodeId,
            terms: reviewerSource.terms,
          },
        ]),
  ];
  const contributionNodes = contributions.map((contribution) =>
    createTermContributionNode(
      session,
      contribution,
      contribution.source === 'reviewer'
        ? (reviewerSource?.sourceNode ?? null)
        : null,
    ),
  );
  const preview = previewInvestigationTermUnion(contributions);
  if (preview.outcome !== 'ready') {
    throw workflowError(
      'INVESTIGATION_TERM_NARROWING_REQUIRED',
      'The current term union exceeds the fixed investigation limits.',
      ExitCode.guard,
      { details: { violations: preview.violations } },
    );
  }
  const termUnionNode = createTermUnionNode(
    session,
    preview.terms,
    preview.rawCounts,
    contributionNodes,
  );
  const providerResultNode = createProviderResultNode(
    session,
    providerRequest,
    invocation.result,
    authorizationNode,
  );
  const providerRoleResult = createBlindSurveyRoleResult(
    context,
    authorization,
    providerRequest,
    invocation.result,
    providerResultNode,
    grantAccess,
    grantValidation,
    assertOwned,
  );
  const scan = scanInvestigationTree({
    repositoryRoot: context.git.repositoryRoot,
    treeOid: session.baseline.tree,
    terms: preview.terms,
  });
  if (scan.outcome !== 'ready') {
    throw workflowError(
      'INVESTIGATION_SCAN_NARROWING_REQUIRED',
      'The current scan exceeds fixed investigation limits.',
      ExitCode.guard,
      { details: { violations: scan.violations } },
    );
  }
  const grouped = deriveInvestigationGroups({
    scanNodes: scan.nodes,
    mutationPolicy: createMutationClassPolicy({
      rules: mutationRules,
    }),
    declaredRoots: [{ rootId: 'repository', path: '' }],
    reviewedRelationships,
    exceptions: [],
  });
  let dispositionNodes: EvidenceNode[] = [];
  if (session.milestones.groupDispositions !== null) {
    const stored = session.milestones.groupDispositions.envelope;
    if (stored.kind !== 'group-dispositions') {
      throw workflowError(
        'INVESTIGATION_CHECKPOINT_INVALID',
        'Stored disposition checkpoint is malformed.',
        ExitCode.staleState,
      );
    }
    dispositionNodes = createInvestigationDispositionNodes({
      groupNodes: grouped.groupNodes,
      dispositions: expandSubmittedDispositions(
        context.git.repositoryRoot,
        {
          scanNodes: scan.nodes,
          groupNodes: grouped.groupNodes,
          payload: stored.payload,
        },
      ),
    });
  }
  const derivedFullBlobManifest =
    session.milestones.groupDispositions === null
      ? []
      : deriveInvestigationFullBlobManifest({
          snapshot,
          hitNodes: grouped.hitNodes,
          groupNodes: grouped.groupNodes,
          dispositionNodes,
        });
  // The ledger sets aside only what it already explains for these exact bytes.
  // Everything it carries keeps its group and its disposition; what it loses is
  // the obligation to be explained again by someone with nothing new to say.
  const manifestReuse = applyLedgerToFullBlobManifest(
    context.git.repositoryRoot,
    derivedFullBlobManifest,
    // Naming the policy that judges this propose is what makes a raised policy
    // able to invalidate an entry. Letting the call default here would echo
    // each entry's own policy back as the current one, and every entry would
    // agree with itself forever.
    { currentPolicyDigest: PROPOSE_POLICY_DIGEST },
  );
  const fullBlobManifest =
    manifestReuse.owed as InvestigationFullBlobManifestEntry[];
  // Taking the saving and recording what it cost are the same act. Every
  // carried entry stays in what a reviewer is shown, marked as carried.
  const reuseCoverage = recordReuseCoverage(manifestReuse);
  let whyNodes: EvidenceNode[] = [];
  if (session.milestones.whyAnswers !== null) {
    const stored = session.milestones.whyAnswers.envelope;
    if (stored.kind !== 'why-answers') {
      throw workflowError(
        'INVESTIGATION_CHECKPOINT_INVALID',
        'Stored WHY checkpoint is malformed.',
        ExitCode.staleState,
      );
    }
    whyNodes = createInvestigationWhyNodes({
      manifest: fullBlobManifest,
      hitNodes: grouped.hitNodes,
      groupNodes: grouped.groupNodes,
      dispositionNodes,
      answers: stored.payload.answers,
    });
  }
  const coverageNode =
    session.milestones.groupDispositions === null
      ? null
      : createInvestigationCoverageNode({
          effectiveTermIds: preview.terms.map(({ termId }) => termId),
          scanNodes: scan.nodes,
          inventoryNode: scan.inventory.evidenceNode,
          hitNodes: grouped.hitNodes,
          groupNodes: grouped.groupNodes,
          dispositionNodes,
        });
  return {
    session,
    intent,
    floor,
    termSources: preview.rawCounts,
    authorizationNode,
    legacyMigration: authorization.legacyMigration,
    providerResultNode,
    providerRoleResult,
    reviewerTermSourceNode: reviewerSource?.sourceNode ?? null,
    reviewerTermSourceNodeIds: reviewerSource?.sourceNodeIds ?? [],
    reviewerTermEvidenceNodes: reviewerSource?.evidenceNodes ?? [],
    reviewerTermReopenCount: reviewerSource?.reopenCount ?? 0,
    reviewerTerms: reviewerSource?.terms ?? [],
    reviewerRoleResult: reviewerSource?.roleResult ?? null,
    reviewerPriorGroupDispositions:
      reviewerSource?.priorGroupDispositions ?? null,
    reviewerPriorWhyAnswers: reviewerSource?.priorWhyAnswers ?? null,
    contributionNodes,
    termUnionNode,
    scanNodes: scan.nodes,
    inventoryNode: scan.inventory.evidenceNode,
    hitNodes: grouped.hitNodes,
    groupNodes: grouped.groupNodes,
    dispositionNodes,
    coverageNode,
    fullBlobManifest,
    reuseCoverage,
    whyNodes,
  };
}

function emptyRebuilt(
  session: InvestigationSession,
  intent: NormalizedChangeIntent,
  floor: ReturnType<typeof deriveEngineFloor>,
  termSources: InvestigationTermRawCounts,
  authorizationNode: EvidenceNode,
  legacyMigration: LegacyPlanMigrationSubject | null,
): RebuiltInvestigation {
  return {
    session,
    intent,
    floor,
    termSources,
    authorizationNode,
    legacyMigration,
    providerResultNode: null,
    providerRoleResult: null,
    reviewerTermSourceNode: null,
    reviewerTermSourceNodeIds: [],
    reviewerTermEvidenceNodes: [],
    reviewerTermReopenCount: 0,
    reviewerTerms: [],
    reviewerRoleResult: null,
    reviewerPriorGroupDispositions: null,
    reviewerPriorWhyAnswers: null,
    contributionNodes: [],
    termUnionNode: null,
    scanNodes: [],
    inventoryNode: null,
    hitNodes: [],
    groupNodes: [],
    dispositionNodes: [],
    coverageNode: null,
    fullBlobManifest: [],
    // An investigation with nothing in it carried nothing, which is a real
    // answer rather than an absent one.
    reuseCoverage: recordReuseCoverage({
      owed: [],
      carried: [],
      plan: null,
    }),
    whyNodes: [],
  };
}

function deriveReviewedAssetRelationships(): ReviewedPathRelationship[] {
  return OPENSPEC_ASSET_DEFINITIONS.filter(
    (
      asset,
    ): asset is (typeof OPENSPEC_ASSET_DEFINITIONS)[number] & {
      mirrorOf: string;
    } => asset.mirrorOf !== null,
  )
    .map((asset) => {
      const reference = `OPENSPEC_ASSET_DEFINITIONS:${asset.mirrorOf}->${asset.destinationPath}`;
      return {
        relationshipId: `openspec-asset-mirror:${sha256(reference)}`,
        kind: 'mirror',
        subjectPath: pathIdentity(asset.mirrorOf),
        counterpartPath: pathIdentity(asset.destinationPath),
        reference,
      };
    })
    .sort((left, right) =>
      left.relationshipId.localeCompare(right.relationshipId),
    );
}

function deriveReviewedCounterpartFacts(
  intent: NormalizedChangeIntent,
  changedPaths: ChangedPathFact[],
  relationships: ReviewedPathRelationship[],
): ReviewedCounterpartFact[] {
  const baseFloor = deriveEngineFloor({
    explicitPaths: intent.explicitPaths,
    symbols: intent.explicitSymbols,
    configKeys: intent.explicitConfigKeys,
    transformations: intent.renamePairs.map((pair, index) => ({
      kind: 'literal-content',
      before: pair.from,
      after: pair.to,
      reference: `intent.renamePairs[${index}]`,
    })),
    changedPaths,
    reviewedCounterparts: [],
  });
  const grounded = new Set(
    baseFloor.outcome === 'derived'
      ? baseFloor.terms.map(({ value }) => value)
      : [],
  );

  const pending = [...relationships];
  const facts: ReviewedCounterpartFact[] = [];
  while (pending.length > 0) {
    const index = pending.findIndex((relationship) => {
      const subject = relationship.subjectPath.utf8;
      const counterpart = relationship.counterpartPath.utf8;
      return (
        subject !== null &&
        counterpart !== null &&
        (grounded.has(subject) || grounded.has(counterpart))
      );
    });
    if (index < 0) {
      break;
    }
    const [relationship] = pending.splice(index, 1);
    const canonical = relationship!.subjectPath.utf8!;
    const mirror = relationship!.counterpartPath.utf8!;
    const subject = grounded.has(canonical) ? canonical : mirror;
    const value = subject === canonical ? mirror : canonical;
    facts.push({
      kind: 'literal-path',
      value,
      subject,
      reference: `${relationship!.reference}:${subject}->${value}`,
    });
    grounded.add(value);
  }
  return facts.sort((left, right) =>
    canonicalJson(left).localeCompare(canonicalJson(right)),
  );
}

function deriveReviewedMutationRules(
  snapshot: TrackedTreeSnapshot,
): MutationClassRule[] {
  const rules = new Map<string, MutationClassRule>();
  const addExactRule = (
    source: string,
    mutationClass: MutationClass,
    relativePath: string,
  ) => {
    const normalized = normalizePolicyPath(relativePath);
    const key = `${mutationClass}:${normalized}`;
    if (rules.has(key)) {
      return;
    }
    rules.set(key, {
      ruleId: `reviewed-mutation:${sha256(
        canonicalJson({ mutationClass, path: normalized, source }),
      )}`,
      mutationClass,
      selector: { kind: 'exact-path', path: normalized },
    });
  };

  for (const asset of OPENSPEC_ASSET_DEFINITIONS) {
    addExactRule(
      `OPENSPEC_ASSET_DEFINITIONS:${asset.destinationPath}`,
      asset.mirrorOf === null ? 'generated' : 'mirror',
      asset.destinationPath,
    );
  }
  addExactRule(
    'OPENSPEC_ASSET_MANIFEST_PATH',
    'generated',
    OPENSPEC_ASSET_MANIFEST_PATH,
  );

  const documentPolicy = readPinnedDocumentPolicy(snapshot);
  const trackedPaths = snapshot.entries
    .map((entry) => entry.path.utf8)
    .filter((value): value is string => value !== null);
  for (const [policyPath, value] of Object.entries(documentPolicy.documents)) {
    const mutationClass = documentModeMutationClass(value.mode);
    if (mutationClass === null) {
      continue;
    }
    for (const trackedPath of trackedPaths) {
      if (documentPolicyMatches(policyPath, trackedPath)) {
        addExactRule(
          `workflow/document-policy.json:${policyPath}`,
          mutationClass,
          trackedPath,
        );
      }
    }
  }
  return [...rules.values()];
}

function readPinnedDocumentPolicy(snapshot: TrackedTreeSnapshot): {
  documents: Record<string, { mode: string }>;
} {
  const policyEntry = snapshot.entries.find(
    (entry) => entry.path.utf8 === 'workflow/document-policy.json',
  );
  if (!policyEntry?.content) {
    throw investigationPolicyInvalid(
      'The pinned document policy is unavailable as a regular text blob.',
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(policyEntry.content),
    );
  } catch {
    throw investigationPolicyInvalid(
      'The pinned document policy is not valid UTF-8 JSON.',
    );
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['documents', 'enforcementMode', 'schemaVersion']) ||
    value.schemaVersion !== 1 ||
    value.enforcementMode !== 'enforced' ||
    !isRecord(value.documents)
  ) {
    throw investigationPolicyInvalid(
      'The pinned document policy envelope is malformed.',
    );
  }
  const documents: Record<string, { mode: string }> = {};
  for (const [policyPath, entry] of Object.entries(value.documents)) {
    if (
      !isRecord(entry) ||
      typeof entry.mode !== 'string' ||
      !DOCUMENT_POLICY_MODES.has(entry.mode)
    ) {
      throw investigationPolicyInvalid(
        `The pinned document policy entry is malformed: ${policyPath}`,
      );
    }
    assertDocumentPolicyPattern(policyPath);
    documents[policyPath] = { mode: entry.mode };
  }
  return { documents };
}

const DOCUMENT_POLICY_MODES = new Set([
  'append-only',
  'change-artifact',
  'curated',
  'generated',
  'immutable',
  'normative',
  'reference',
]);

function documentModeMutationClass(mode: string): MutationClass | null {
  switch (mode) {
    case 'generated':
      return 'generated';
    case 'append-only':
      return 'append-only';
    case 'immutable':
      return 'immutable';
    case 'reference':
      return 'historical-reference';
    default:
      return null;
  }
}

function assertDocumentPolicyPattern(policyPath: string): void {
  if (
    policyPath.length === 0 ||
    policyPath.startsWith('/') ||
    policyPath.includes('\\') ||
    policyPath.includes('\0') ||
    !/^[A-Za-z0-9._*/-]+$/.test(policyPath) ||
    policyPath
      .split('/')
      .some((segment) => segment.length === 0 || segment === '..')
  ) {
    throw investigationPolicyInvalid(
      `The pinned document policy path is unsafe: ${policyPath}`,
    );
  }
}

function documentPolicyMatches(
  policyPath: string,
  trackedPath: string,
): boolean {
  if (!policyPath.includes('*')) {
    return normalizePolicyPath(policyPath) === trackedPath;
  }
  try {
    return path.matchesGlob(trackedPath, policyPath);
  } catch {
    throw investigationPolicyInvalid(
      `The pinned document policy glob is invalid: ${policyPath}`,
    );
  }
}

function pathIdentity(relativePath: string): {
  rawBase64: string;
  utf8: string;
} {
  const normalized = normalizePolicyPath(relativePath);
  return {
    rawBase64: Buffer.from(normalized, 'utf8').toString('base64'),
    utf8: normalized,
  };
}

function workFromRebuilt(
  rebuilt: RebuiltInvestigation,
  authoredInstructions: ProposeWork['authoredInstructions'],
): ProposeWork {
  const reusableGroupIds = new Set(
    reviewerReusableGroupDispositions(rebuilt).map(({ groupId }) => groupId),
  );
  const reusableManifestEntryIds = new Set(
    reviewerReusableWhyAnswers(rebuilt).map(
      ({ manifestEntryId }) => manifestEntryId,
    ),
  );
  const classGroupsById = new Map(
    deriveClassGroupsWithContext({
      scanNodes: rebuilt.scanNodes,
      groupNodes: rebuilt.groupNodes,
    }).map((group) => [group.groupId, group]),
  );
  return {
    termSources: rebuilt.termSources,
    groups: rebuilt.groupNodes
      .map((node) => {
        const group = readInvestigationGroupNode(node);
        const withContext = classGroupsById.get(group.groupId);
        return {
          groupId: group.groupId,
          termId: group.selector.termId,
          paths: [
            ...new Set(
              group.hits
                .map(({ path: hitPath }) => hitPath.utf8)
                .filter((value): value is string => value !== null),
            ),
          ].sort(),
          hitIds: group.hitIds,
          hits: (withContext?.hits ?? []).map((hit) => ({
            path: hit.path,
            // A hit the join could not place is reported as a path hit, which
            // is the reading that can claim the least.
            surface: hit.surface ?? 'path',
            window: hit.window?.utf8 ?? null,
            windowTruncated: hit.window?.truncated ?? false,
            matchOffset: hit.matchOffset,
            matchLength: hit.matchLength,
          })),
        };
      })
      .filter(({ groupId }) => !reusableGroupIds.has(groupId)),
    fullBlobManifest: rebuilt.fullBlobManifest
      .filter(
        ({ manifestEntryId }) => !reusableManifestEntryIds.has(manifestEntryId),
      )
      .map((entry) => ({
        manifestEntryId: entry.manifestEntryId,
        path: entry.path.utf8 ?? `base64:${entry.path.rawBase64}`,
        objectId: entry.blob.objectId,
        contentSha256: entry.blob.contentSha256,
        contentBase64: entry.blob.contentBase64,
      })),
    authoredInstructions,
  };
}

/**
 * Reads the registry that decides which paths may be folded into a class.
 *
 * A repository with no registry has classified nothing, and nothing
 * unclassified is ever compressible, so the honest answer is a refusal naming
 * the missing file rather than a crash or a permissive default.
 */
function readPathRoleRegistryForClasses(repositoryRoot: string) {
  const registryPath = path.join(repositoryRoot, 'workflow/path-roles.json');
  if (!fs.existsSync(registryPath)) {
    throw workflowError(
      'CLASS_DISPOSITION_INVALID',
      `A class disposition needs ${'workflow/path-roles.json'} to say which paths may be folded; this repository has not classified any.`,
      ExitCode.usage,
    );
  }
  return parsePathRoleRegistry(
    JSON.parse(fs.readFileSync(registryPath, 'utf8')),
  );
}

/**
 * Turns whatever an author wrote into the one disposition per group the
 * evidence has always required.
 *
 * A class is an authoring shape, not a weaker claim: the engine expands it into
 * exactly the per-group dispositions the author would otherwise have written by
 * hand, and every downstream check — partition, coverage, DAG — runs unchanged
 * on the result. What a class removes is the obligation to retype the same
 * rationale for hits a machine can show are equivalent.
 *
 * The expansion recomputes admissibility from the scans rather than trusting
 * the submission: membership is checked hit by hit against the class predicate,
 * the predicate must discriminate members from every other hit the same scan
 * produced, and a group whose term saturated is never foldable because its hits
 * are known to be incomplete.
 */
function expandSubmittedDispositions(
  repositoryRoot: string,
  input: {
    scanNodes: EvidenceNode[];
    groupNodes: EvidenceNode[];
    payload: GroupDispositionsPayload;
    saturatedTermIds?: readonly string[];
  },
): InvestigationDispositionInput[] {
  const classes = input.payload.classes ?? [];
  if (classes.length === 0) return input.payload.dispositions;
  const expansion = expandClassDispositions(
    // Parsed here, not trusted as stored: the checkpoint keeps what the author
    // wrote, and a predicate only means anything once it has been read by the
    // contract that defines it.
    classes.map((declared) => parseClassDisposition(declared)),
    deriveClassGroupsWithContext({
      scanNodes: input.scanNodes,
      groupNodes: input.groupNodes,
    }),
    readPathRoleRegistryForClasses(repositoryRoot),
    input.saturatedTermIds === undefined
      ? {}
      : { saturatedTermIds: input.saturatedTermIds },
  );
  return [
    ...input.payload.dispositions,
    ...expansion.dispositions.map(
      ({ groupId, classification, rationale, author }) => ({
        groupId,
        classification,
        rationale,
        author,
      }),
    ),
  ];
}

function reviewerReusableGroupDispositions(
  rebuilt: RebuiltInvestigation,
): InvestigationDispositionInput[] {
  const checkpoint = rebuilt.reviewerPriorGroupDispositions?.envelope;
  if (checkpoint?.kind !== 'group-dispositions') {
    return [];
  }
  const currentGroupIds = new Set(
    rebuilt.groupNodes.map((node) => readInvestigationGroupNode(node).groupId),
  );
  return checkpoint.payload.dispositions.filter(({ groupId }) =>
    currentGroupIds.has(groupId),
  );
}

function reviewerReusableWhyAnswers(
  rebuilt: RebuiltInvestigation,
): InvestigationWhyAnswer[] {
  const checkpoint = rebuilt.reviewerPriorWhyAnswers?.envelope;
  if (checkpoint?.kind !== 'why-answers') {
    return [];
  }
  const currentEntryIds = new Set(
    rebuilt.fullBlobManifest.map(({ manifestEntryId }) => manifestEntryId),
  );
  return checkpoint.payload.answers.filter(({ manifestEntryId }) =>
    currentEntryIds.has(manifestEntryId),
  );
}

function mergeReviewerReopenCheckpoint(
  rebuilt: RebuiltInvestigation,
  checkpoint: InvestigationCheckpointEnvelope,
): InvestigationCheckpointEnvelope {
  if (checkpoint.kind === 'main-terms') {
    return checkpoint;
  }
  if (checkpoint.kind === 'group-dispositions') {
    const reusable = reviewerReusableGroupDispositions(rebuilt);
    const reusableIds = new Set(reusable.map(({ groupId }) => groupId));
    if (
      checkpoint.payload.dispositions.some(({ groupId }) =>
        reusableIds.has(groupId),
      )
    ) {
      throw workflowError(
        'INVESTIGATION_REVIEWER_REOPEN_SCOPE_INVALID',
        'Reviewer-term reopening accepts answers only for new or changed groups.',
        ExitCode.guard,
      );
    }
    return assertInvestigationCheckpointEnvelope({
      ...checkpoint,
      payload: {
        // Classes survive the merge: dropping them here would silently turn a
        // covered submission into an incomplete one.
        ...(checkpoint.payload.classes === undefined
          ? {}
          : { classes: checkpoint.payload.classes }),
        dispositions: [...reusable, ...checkpoint.payload.dispositions].sort(
          (left, right) => left.groupId.localeCompare(right.groupId),
        ),
      },
    });
  }
  const reusable = reviewerReusableWhyAnswers(rebuilt);
  const reusableIds = new Set(
    reusable.map(({ manifestEntryId }) => manifestEntryId),
  );
  if (
    checkpoint.payload.answers.some(({ manifestEntryId }) =>
      reusableIds.has(manifestEntryId),
    )
  ) {
    throw workflowError(
      'INVESTIGATION_REVIEWER_REOPEN_SCOPE_INVALID',
      'Reviewer-term reopening accepts WHY answers only for new or changed manifest rows.',
      ExitCode.guard,
    );
  }
  return assertInvestigationCheckpointEnvelope({
    ...checkpoint,
    payload: {
      answers: [...reusable, ...checkpoint.payload.answers].sort(
        (left, right) =>
          left.manifestEntryId.localeCompare(right.manifestEntryId),
      ),
    },
  });
}

function createTermContributionNode(
  session: InvestigationSession,
  contribution: InvestigationTermContribution,
  reviewerSourceNode: EvidenceNode | null = null,
): EvidenceNode {
  return createEvidenceNode({
    type: 'investigation-term-contribution',
    nodeSchema: 'investigation.term-contribution.v2',
    evaluator: 'workflow-propose.term-contribution.v2',
    policyDigest: PROPOSE_POLICY_DIGEST,
    exactInputDigests: {
      baseline: sha256(canonicalJson(session.baseline)),
      contribution: sha256(canonicalJson(contribution)),
    },
    semanticParentResultDigests:
      reviewerSourceNode === null
        ? {}
        : { reviewerSource: reviewerSourceNode.resultDigest },
    provenanceParentNodeIds:
      reviewerSourceNode === null
        ? {}
        : { reviewerSource: reviewerSourceNode.nodeId },
    outputSchema: 'investigation.term-contribution-output.v2',
    output: contribution,
    runtimeMetadata: {},
  });
}

function createReviewerTermSourceNode(input: {
  status: InvestigationStatus;
  providerResultNode: EvidenceNode;
  reviewNode: EvidenceNode;
  roleResult: AdmittedRoleResult;
  terms: Array<{
    kind: 'literal-content' | 'literal-path' | 'symbol' | 'config-key';
    value: string;
  }>;
  priorGroupDispositions: StoredInvestigationCheckpoint;
  priorWhyAnswers: StoredInvestigationCheckpoint;
  previousReviewerTermSourceNode: EvidenceNode | null;
  authorizationResolutionNodeId: string | null;
}): EvidenceNode {
  return createEvidenceNode({
    type: 'investigation-reviewer-term-source',
    nodeSchema: 'investigation.reviewer-term-source.v3',
    evaluator: 'workflow-propose.reviewer-term-source.v3',
    policyDigest: PROPOSE_POLICY_DIGEST,
    exactInputDigests: {
      baseline: sha256(canonicalJson(input.status.baseline)),
      terms: sha256(canonicalJson(input.terms)),
      roleResult: input.roleResult.resultDigest,
      priorGroupDispositions: input.priorGroupDispositions.envelopeDigest,
      priorWhyAnswers: input.priorWhyAnswers.envelopeDigest,
      ...(input.previousReviewerTermSourceNode === null
        ? {}
        : {
            previousReviewerTerms: input.previousReviewerTermSourceNode.nodeId,
          }),
      ...(input.authorizationResolutionNodeId === null
        ? {}
        : {
            humanResolution: input.authorizationResolutionNodeId,
          }),
    },
    semanticParentResultDigests: {
      review: input.reviewNode.resultDigest,
      providerResult: input.providerResultNode.resultDigest,
      ...(input.previousReviewerTermSourceNode === null
        ? {}
        : {
            previousReviewerTerms:
              input.previousReviewerTermSourceNode.resultDigest,
          }),
    },
    provenanceParentNodeIds: {
      review: input.reviewNode.nodeId,
      providerResult: input.providerResultNode.nodeId,
      ...(input.previousReviewerTermSourceNode === null
        ? {}
        : {
            previousReviewerTerms: input.previousReviewerTermSourceNode.nodeId,
          }),
    },
    outputSchema: 'investigation.reviewer-term-source-output.v3',
    output: {
      investigationId: input.status.investigationId,
      baseline: input.status.baseline,
      providerResultNode: input.providerResultNode,
      reviewNode: input.reviewNode,
      roleResult: input.roleResult,
      terms: input.terms,
      priorGroupDispositions: input.priorGroupDispositions,
      priorWhyAnswers: input.priorWhyAnswers,
      previousReviewerTermSourceNodeId:
        input.previousReviewerTermSourceNode?.nodeId ?? null,
      authorizationResolutionNodeId: input.authorizationResolutionNodeId,
    },
    runtimeMetadata: {},
  });
}

type ReviewerTermSourceRecord = {
  sourceNode: EvidenceNode;
  providerResultNode: EvidenceNode;
  reviewNode: EvidenceNode;
  targetSnapshotNode: EvidenceNode | null;
  evidenceNodes: EvidenceNode[];
  roleResult: AdmittedRoleResult;
  priorGroupDispositions: StoredInvestigationCheckpoint;
  priorWhyAnswers: StoredInvestigationCheckpoint;
  sourceNodeIds: string[];
  reopenCount: number;
  terms: Array<{
    kind: 'literal-content' | 'literal-path' | 'symbol' | 'config-key';
    value: string;
  }>;
};

function readReviewerTermSource(
  paths: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  nodeId: string | null,
  session: InvestigationSession,
): ReviewerTermSourceRecord | null {
  if (nodeId === null) {
    return null;
  }
  const sourceNode = readEvidenceNode(paths, nodeId);
  if (
    sourceNode.nodeSchema === 'investigation.reviewer-term-source.v3' ||
    sourceNode.evaluator === 'workflow-propose.reviewer-term-source.v3'
  ) {
    return readReviewerTermSourceV3(paths, sourceNode, session);
  }
  const output = sourceNode.output;
  if (
    sourceNode.type !== 'investigation-reviewer-term-source' ||
    sourceNode.nodeSchema !== 'investigation.reviewer-term-source.v2' ||
    sourceNode.evaluator !== 'workflow-propose.reviewer-term-source.v2' ||
    sourceNode.policyDigest !== PROPOSE_POLICY_DIGEST ||
    !isRecord(output) ||
    !hasExactKeys(output, [
      'investigationId',
      'baseline',
      'providerResultNode',
      'reviewNode',
      'roleResult',
      'terms',
      'priorGroupDispositions',
      'priorWhyAnswers',
    ]) ||
    !isRecord(output.providerResultNode) ||
    !isRecord(output.reviewNode) ||
    !isRecord(output.roleResult) ||
    !isRecord(output.priorGroupDispositions) ||
    !isRecord(output.priorWhyAnswers) ||
    !hasExactKeys(output.priorGroupDispositions, [
      'envelopeDigest',
      'contributionDigest',
      'envelope',
    ]) ||
    !hasExactKeys(output.priorWhyAnswers, [
      'envelopeDigest',
      'contributionDigest',
      'envelope',
    ]) ||
    !Array.isArray(output.terms)
  ) {
    throw workflowError(
      'INVESTIGATION_REVIEWER_TERM_SOURCE_INVALID',
      'Reviewer-term source evidence is malformed.',
      ExitCode.staleState,
    );
  }
  const embeddedProviderResultNode = output.providerResultNode as EvidenceNode;
  const reviewNode = output.reviewNode as EvidenceNode;
  const roleResult = output.roleResult as AdmittedRoleResult;
  const rawPriorGroupDispositions = output.priorGroupDispositions as Record<
    string,
    unknown
  >;
  const rawPriorWhyAnswers = output.priorWhyAnswers as Record<string, unknown>;
  const priorGroupEnvelope = assertInvestigationCheckpointEnvelope(
    rawPriorGroupDispositions.envelope,
  );
  const priorWhyEnvelope = assertInvestigationCheckpointEnvelope(
    rawPriorWhyAnswers.envelope,
  );
  const priorGroupDispositions: StoredInvestigationCheckpoint = {
    envelopeDigest: String(rawPriorGroupDispositions.envelopeDigest),
    contributionDigest: String(rawPriorGroupDispositions.contributionDigest),
    envelope: priorGroupEnvelope,
  };
  const priorWhyAnswers: StoredInvestigationCheckpoint = {
    envelopeDigest: String(rawPriorWhyAnswers.envelopeDigest),
    contributionDigest: String(rawPriorWhyAnswers.contributionDigest),
    envelope: priorWhyEnvelope,
  };
  const review = readPlanReviewNode(reviewNode);
  const { providerResultNode, targetSnapshotNode } =
    readReviewerTermProviderResult(paths, embeddedProviderResultNode, review);
  const terms = output.terms as Array<{
    kind: 'literal-content' | 'literal-path' | 'symbol' | 'config-key';
    value: string;
  }>;
  if (
    output.investigationId !== session.investigationId ||
    !isBaseline(output.baseline) ||
    canonicalJson(output.baseline) !== canonicalJson(session.baseline) ||
    canonicalJson(terms) !== canonicalJson(review.proposedTerms) ||
    providerResultNode.nodeId !== review.providerResultNodeId ||
    providerResultNode.resultDigest !== review.providerResultResultDigest ||
    roleResult.content.nodeId !== reviewNode.nodeId ||
    roleResult.content.resultDigest !== reviewNode.resultDigest ||
    sourceNode.exactInputDigests.baseline !==
      sha256(canonicalJson(output.baseline)) ||
    sourceNode.exactInputDigests.terms !== sha256(canonicalJson(terms)) ||
    sourceNode.exactInputDigests.roleResult !== roleResult.resultDigest ||
    priorGroupDispositions.envelopeDigest !==
      sourceNode.exactInputDigests.priorGroupDispositions ||
    priorWhyAnswers.envelopeDigest !==
      sourceNode.exactInputDigests.priorWhyAnswers ||
    priorGroupDispositions.envelopeDigest !==
      sha256(canonicalJson(priorGroupEnvelope)) ||
    priorWhyAnswers.envelopeDigest !==
      sha256(canonicalJson(priorWhyEnvelope)) ||
    priorGroupDispositions.contributionDigest !==
      checkpointContributionDigest(priorGroupEnvelope) ||
    priorWhyAnswers.contributionDigest !==
      checkpointContributionDigest(priorWhyEnvelope) ||
    priorGroupDispositions.envelope.kind !== 'group-dispositions' ||
    priorWhyAnswers.envelope.kind !== 'why-answers' ||
    priorGroupEnvelope.investigationId !== output.investigationId ||
    priorWhyEnvelope.investigationId !== output.investigationId ||
    priorGroupEnvelope.changeId !== session.changeId ||
    priorWhyEnvelope.changeId !== session.changeId ||
    priorGroupEnvelope.intentDigest !== session.intentDigest ||
    priorWhyEnvelope.intentDigest !== session.intentDigest ||
    priorGroupEnvelope.blindManifestDigest !== session.blindManifestDigest ||
    priorWhyEnvelope.blindManifestDigest !== session.blindManifestDigest ||
    canonicalJson(priorGroupEnvelope.baseline) !==
      canonicalJson(output.baseline) ||
    canonicalJson(priorWhyEnvelope.baseline) !==
      canonicalJson(output.baseline) ||
    sourceNode.provenanceParentNodeIds.review !== reviewNode.nodeId ||
    sourceNode.semanticParentResultDigests.review !== reviewNode.resultDigest ||
    sourceNode.provenanceParentNodeIds.providerResult !==
      providerResultNode.nodeId ||
    sourceNode.semanticParentResultDigests.providerResult !==
      providerResultNode.resultDigest ||
    providerResultNode.exactInputDigests.targetSnapshot !==
      targetSnapshotNode.nodeId ||
    providerResultNode.semanticParentResultDigests.targetSnapshot !==
      targetSnapshotNode.resultDigest
  ) {
    throw workflowError(
      'INVESTIGATION_REVIEWER_TERM_SOURCE_INVALID',
      'Reviewer-term source evidence no longer matches its review and admitted role result.',
      ExitCode.staleState,
    );
  }
  return {
    sourceNode,
    providerResultNode,
    reviewNode,
    targetSnapshotNode,
    evidenceNodes: [
      ...(targetSnapshotNode === null ? [] : [targetSnapshotNode]),
      providerResultNode,
      reviewNode,
      sourceNode,
    ],
    roleResult,
    terms,
    priorGroupDispositions,
    priorWhyAnswers,
    sourceNodeIds: [sourceNode.nodeId],
    reopenCount: 1,
  };
}

function readReviewerTermSourceV3(
  paths: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  sourceNode: EvidenceNode,
  session: InvestigationSession,
): ReviewerTermSourceRecord {
  const output = sourceNode.output;
  if (
    sourceNode.type !== 'investigation-reviewer-term-source' ||
    sourceNode.nodeSchema !== 'investigation.reviewer-term-source.v3' ||
    sourceNode.evaluator !== 'workflow-propose.reviewer-term-source.v3' ||
    sourceNode.outputSchema !==
      'investigation.reviewer-term-source-output.v3' ||
    sourceNode.policyDigest !== PROPOSE_POLICY_DIGEST ||
    !isRecord(output) ||
    !hasExactKeys(output, [
      'investigationId',
      'baseline',
      'providerResultNode',
      'reviewNode',
      'roleResult',
      'terms',
      'priorGroupDispositions',
      'priorWhyAnswers',
      'previousReviewerTermSourceNodeId',
      'authorizationResolutionNodeId',
    ]) ||
    !isRecord(output.providerResultNode) ||
    !isRecord(output.reviewNode) ||
    !isRecord(output.roleResult) ||
    !isRecord(output.priorGroupDispositions) ||
    !isRecord(output.priorWhyAnswers) ||
    !Array.isArray(output.terms) ||
    (output.previousReviewerTermSourceNodeId !== null &&
      typeof output.previousReviewerTermSourceNodeId !== 'string') ||
    (output.authorizationResolutionNodeId !== null &&
      typeof output.authorizationResolutionNodeId !== 'string')
  ) {
    throw invalidReviewerTermSource();
  }
  const previous = readReviewerTermSource(
    paths,
    output.previousReviewerTermSourceNodeId,
    session,
  );
  const embeddedProviderResultNode = output.providerResultNode as EvidenceNode;
  const reviewNode = output.reviewNode as EvidenceNode;
  const review = readPlanReviewNode(reviewNode);
  const { providerResultNode, targetSnapshotNode } =
    readReviewerTermProviderResult(paths, embeddedProviderResultNode, review);
  const roleResult = output.roleResult as AdmittedRoleResult;
  const rawPriorGroupDispositions = output.priorGroupDispositions as Record<
    string,
    unknown
  >;
  const rawPriorWhyAnswers = output.priorWhyAnswers as Record<string, unknown>;
  if (
    !hasExactKeys(rawPriorGroupDispositions, [
      'envelopeDigest',
      'contributionDigest',
      'envelope',
    ]) ||
    !hasExactKeys(rawPriorWhyAnswers, [
      'envelopeDigest',
      'contributionDigest',
      'envelope',
    ])
  ) {
    throw invalidReviewerTermSource();
  }
  const priorGroupEnvelope = assertInvestigationCheckpointEnvelope(
    rawPriorGroupDispositions.envelope,
  );
  const priorWhyEnvelope = assertInvestigationCheckpointEnvelope(
    rawPriorWhyAnswers.envelope,
  );
  const priorGroupDispositions: StoredInvestigationCheckpoint = {
    envelopeDigest: String(rawPriorGroupDispositions.envelopeDigest),
    contributionDigest: String(rawPriorGroupDispositions.contributionDigest),
    envelope: priorGroupEnvelope,
  };
  const priorWhyAnswers: StoredInvestigationCheckpoint = {
    envelopeDigest: String(rawPriorWhyAnswers.envelopeDigest),
    contributionDigest: String(rawPriorWhyAnswers.contributionDigest),
    envelope: priorWhyEnvelope,
  };
  let terms: ReviewerTermSourceRecord['terms'];
  try {
    terms = assertStoredReviewerTermDelta({
      proposedTerms: review.proposedTerms,
      priorReviewerTerms: previous?.terms ?? [],
      storedTerms: output.terms as ReviewerTermSourceRecord['terms'],
    });
  } catch {
    throw invalidReviewerTermSource();
  }
  const previousNodeId = output.previousReviewerTermSourceNodeId as
    string | null;
  const authorizationNodeId = output.authorizationResolutionNodeId as
    string | null;
  const exactRoles = [
    'baseline',
    'terms',
    'roleResult',
    'priorGroupDispositions',
    'priorWhyAnswers',
    ...(previousNodeId === null ? [] : ['previousReviewerTerms']),
    ...(authorizationNodeId === null ? [] : ['humanResolution']),
  ];
  const parentRoles = [
    'review',
    'providerResult',
    ...(previousNodeId === null ? [] : ['previousReviewerTerms']),
  ];
  if (
    output.investigationId !== session.investigationId ||
    !isBaseline(output.baseline) ||
    canonicalJson(output.baseline) !== canonicalJson(session.baseline) ||
    providerResultNode.nodeId !== review.providerResultNodeId ||
    providerResultNode.resultDigest !== review.providerResultResultDigest ||
    roleResult.content.nodeId !== reviewNode.nodeId ||
    roleResult.content.resultDigest !== reviewNode.resultDigest ||
    !hasExactKeys(sourceNode.exactInputDigests, exactRoles) ||
    !hasExactKeys(sourceNode.semanticParentResultDigests, parentRoles) ||
    !hasExactKeys(sourceNode.provenanceParentNodeIds, parentRoles) ||
    sourceNode.exactInputDigests.baseline !==
      sha256(canonicalJson(output.baseline)) ||
    sourceNode.exactInputDigests.terms !== sha256(canonicalJson(terms)) ||
    sourceNode.exactInputDigests.roleResult !== roleResult.resultDigest ||
    sourceNode.exactInputDigests.priorGroupDispositions !==
      priorGroupDispositions.envelopeDigest ||
    sourceNode.exactInputDigests.priorWhyAnswers !==
      priorWhyAnswers.envelopeDigest ||
    sourceNode.provenanceParentNodeIds.review !== reviewNode.nodeId ||
    sourceNode.semanticParentResultDigests.review !== reviewNode.resultDigest ||
    sourceNode.provenanceParentNodeIds.providerResult !==
      providerResultNode.nodeId ||
    sourceNode.semanticParentResultDigests.providerResult !==
      providerResultNode.resultDigest ||
    priorGroupDispositions.envelopeDigest !==
      sha256(canonicalJson(priorGroupEnvelope)) ||
    priorWhyAnswers.envelopeDigest !==
      sha256(canonicalJson(priorWhyEnvelope)) ||
    priorGroupDispositions.contributionDigest !==
      checkpointContributionDigest(priorGroupEnvelope) ||
    priorWhyAnswers.contributionDigest !==
      checkpointContributionDigest(priorWhyEnvelope) ||
    priorGroupEnvelope.kind !== 'group-dispositions' ||
    priorWhyEnvelope.kind !== 'why-answers' ||
    priorGroupEnvelope.investigationId !== session.investigationId ||
    priorWhyEnvelope.investigationId !== session.investigationId ||
    priorGroupEnvelope.changeId !== session.changeId ||
    priorWhyEnvelope.changeId !== session.changeId ||
    priorGroupEnvelope.intentDigest !== session.intentDigest ||
    priorWhyEnvelope.intentDigest !== session.intentDigest ||
    priorGroupEnvelope.blindManifestDigest !== session.blindManifestDigest ||
    priorWhyEnvelope.blindManifestDigest !== session.blindManifestDigest ||
    canonicalJson(priorGroupEnvelope.baseline) !==
      canonicalJson(output.baseline) ||
    canonicalJson(priorWhyEnvelope.baseline) !==
      canonicalJson(output.baseline) ||
    previousNodeId !== (previous?.sourceNode.nodeId ?? null) ||
    (previous !== null &&
      (sourceNode.exactInputDigests.previousReviewerTerms !==
        previous.sourceNode.nodeId ||
        sourceNode.provenanceParentNodeIds.previousReviewerTerms !==
          previous.sourceNode.nodeId ||
        sourceNode.semanticParentResultDigests.previousReviewerTerms !==
          previous.sourceNode.resultDigest)) ||
    providerResultNode.exactInputDigests.targetSnapshot !==
      targetSnapshotNode.nodeId ||
    providerResultNode.semanticParentResultDigests.targetSnapshot !==
      targetSnapshotNode.resultDigest
  ) {
    throw invalidReviewerTermSource();
  }
  if (authorizationNodeId !== null) {
    const authorization = readHumanResolutionNode(paths, authorizationNodeId);
    if (
      authorization.target.workflowId !== session.investigationId ||
      authorization.target.changeId !== session.changeId ||
      authorization.decision.kind !== 'resume-with-capability' ||
      sourceNode.exactInputDigests.humanResolution !== authorization.nodeId
    ) {
      throw invalidReviewerTermSource();
    }
  }
  const cumulative = new Map<
    string,
    ReviewerTermSourceRecord['terms'][number]
  >();
  for (const term of [...(previous?.terms ?? []), ...terms]) {
    cumulative.set(normalizeInvestigationTerm(term).termId, term);
  }
  return {
    sourceNode,
    providerResultNode,
    reviewNode,
    targetSnapshotNode,
    evidenceNodes: [
      ...(previous?.evidenceNodes ?? []),
      ...(targetSnapshotNode === null ? [] : [targetSnapshotNode]),
      providerResultNode,
      reviewNode,
      sourceNode,
    ],
    roleResult,
    priorGroupDispositions,
    priorWhyAnswers,
    sourceNodeIds: [...(previous?.sourceNodeIds ?? []), sourceNode.nodeId],
    reopenCount: (previous?.reopenCount ?? 0) + 1,
    terms: [...cumulative.values()],
  };
}

function readReviewerTermProviderResult(
  paths: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  value: EvidenceNode,
  review: ReturnType<typeof readPlanReviewNode>,
): { providerResultNode: EvidenceNode; targetSnapshotNode: EvidenceNode } {
  try {
    const providerResultNode = assertStoredEvidenceNode(
      value,
      invalidReviewerTermSource,
    );
    if (
      providerResultNode.type !== 'plan-review-provider-result' ||
      providerResultNode.nodeSchema !== 'plan-review-provider-result.v2' ||
      providerResultNode.evaluator !== 'plan-review-provider-result.v2' ||
      providerResultNode.outputSchema !==
        'plan-review-provider-result-output.v2' ||
      !hasExactKeys(providerResultNode.exactInputDigests, [
        'assignment',
        'subject',
        'submission',
        'targetSnapshot',
      ]) ||
      !hasExactKeys(providerResultNode.semanticParentResultDigests, [
        'targetSnapshot',
      ]) ||
      !hasExactKeys(providerResultNode.provenanceParentNodeIds, [
        'targetSnapshot',
      ]) ||
      Object.keys(providerResultNode.runtimeMetadata).length !== 0 ||
      providerResultNode.exactInputDigests.subject !== review.subjectDigest
    ) {
      throw invalidReviewerTermSource();
    }
    const targetSnapshotNode = readEvidenceNode(
      paths,
      providerResultNode.provenanceParentNodeIds.targetSnapshot!,
    );
    const targetSnapshot = readPlanReviewTargetSnapshotNode(targetSnapshotNode);
    if (
      providerResultNode.exactInputDigests.targetSnapshot !==
        targetSnapshotNode.nodeId ||
      providerResultNode.semanticParentResultDigests.targetSnapshot !==
        targetSnapshotNode.resultDigest ||
      targetSnapshotNode.policyDigest !== review.policyDigest ||
      targetSnapshot.subjectDigest !== review.subjectDigest ||
      targetSnapshot.planningGenerationId !== review.planningGenerationId ||
      targetSnapshot.planTargetDigest !== review.planTargetDigest
    ) {
      throw invalidReviewerTermSource();
    }
    return { providerResultNode, targetSnapshotNode };
  } catch {
    throw invalidReviewerTermSource();
  }
}

function invalidReviewerTermSource() {
  return workflowError(
    'INVESTIGATION_REVIEWER_TERM_SOURCE_INVALID',
    'Reviewer-term source evidence is malformed or no longer bound.',
    ExitCode.staleState,
  );
}

function createTermUnionNode(
  session: InvestigationSession,
  terms: PreviewInvestigationTerm[],
  rawCounts: InvestigationTermRawCounts,
  contributionNodes: EvidenceNode[],
): EvidenceNode {
  const semanticParentResultDigests: Record<string, string> = {};
  const provenanceParentNodeIds: Record<string, string> = {};
  [...contributionNodes]
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId))
    .forEach((node, index) => {
      semanticParentResultDigests[`contribution-${index}`] = node.resultDigest;
      provenanceParentNodeIds[`contribution-${index}`] = node.nodeId;
    });
  return createEvidenceNode({
    type: 'investigation-term-union',
    nodeSchema: 'investigation.term-union.v2',
    evaluator: 'workflow-propose.term-union.v2',
    policyDigest: PROPOSE_POLICY_DIGEST,
    exactInputDigests: {
      baseline: sha256(canonicalJson(session.baseline)),
      terms: sha256(canonicalJson(terms)),
    },
    semanticParentResultDigests,
    provenanceParentNodeIds,
    outputSchema: 'investigation.term-union-output.v2',
    output: { rawCounts, terms },
    runtimeMetadata: {},
  });
}

function createProviderResultNode(
  session: InvestigationSession,
  request: ProviderInvocationRequest,
  result: ProviderProcessResult,
  authorizationNode: EvidenceNode,
): EvidenceNode {
  return createEvidenceNode({
    type: 'investigation-provider-result',
    nodeSchema: 'investigation.provider-result.v1',
    evaluator: 'workflow-propose.v1',
    policyDigest: PROPOSE_POLICY_DIGEST,
    exactInputDigests: {
      baseline: sha256(canonicalJson(session.baseline)),
      request: request.requestDigest,
      result: result.outputDigest,
    },
    semanticParentResultDigests: {
      authorization: authorizationNode.resultDigest,
    },
    provenanceParentNodeIds: {
      authorization: authorizationNode.nodeId,
    },
    outputSchema: 'investigation.provider-result-output.v1',
    output: { request, result },
    runtimeMetadata: {},
  });
}

function createBlindSurveyRoleResult(
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  authorization: ReturnType<typeof readProposeAuthorization>,
  request: ProviderInvocationRequest,
  result: ProviderProcessResult,
  providerResultNode: EvidenceNode,
  grantAccess: CollaborationGrantAccessMode,
  validation?: ProposeResumeOptions['collaborationGrantValidation'],
  assertOwned?: () => void,
): AdmittedRoleResult {
  const grantAuthorization = authorization.grantAuthorization;
  const content = {
    kind: 'blind-survey' as const,
    nodeId: providerResultNode.nodeId,
    resultDigest: providerResultNode.resultDigest,
    outputSchema: BLIND_SURVEY_OUTPUT_SCHEMA,
    evaluator: request.evaluatorVersion,
    policyDigest: request.policyDigest,
    contentDigest: providerResultNode.resultDigest,
    current: true as const,
  };
  const author: RecordedRoleParticipant = {
    providerId: authorization.actor.providerId,
    sessionId: `author-${authorization.actor.providerId}`,
    principalId: null,
    identityAssurance: authorization.actor.assurance,
    engineSpawned: false,
  };
  const participant: RecordedRoleParticipant =
    'grantId' in request.roleAssignment
      ? request.roleAssignment.participant
      : {
          providerId: request.roleAssignment.providerId,
          sessionId: request.roleAssignment.sessionId,
          principalId: null,
          identityAssurance: 'adapter-assigned',
          engineSpawned: true,
        };
  let grantUse: CollaborationGrantUseProjection | null = null;
  let grantAdmission: NonNullable<
    Parameters<typeof admitRoleResult>[0]['grantValidation']
  > | null = null;
  if ('grantId' in request.roleAssignment) {
    if (
      grantAuthorization === null ||
      grantAuthorization.grantId !== request.roleAssignment.grantId
    ) {
      throw workflowError(
        'COLLABORATION_GRANT_ADMISSION_REQUIRED',
        'A granted blind survey requires its exact durable grant authorization.',
        ExitCode.guard,
      );
    }
    const policy = loadMaintainerPolicyAtCommit(
      context.git.repositoryRoot,
      grantAuthorization.expectedBinding.baselineCommit,
    );
    const verifier =
      validation?.verifier ??
      createInteractiveSshSigner(context.git.repositoryRoot, policy);
    const now = validation?.now ?? new Date();
    const consumption = {
      transitionDigest: grantAuthorization.transitionDigest,
      assignment: request.roleAssignment,
      contentAdmission: {
        kind: content.kind,
        nodeId: content.nodeId,
        resultDigest: content.resultDigest,
        current: true as const,
      },
      now,
    };
    const use =
      grantAccess === 'replay-consumed'
        ? readExactConsumedCollaborationGrantUse(
            context.git.gitCommonDirectory,
            grantAuthorization.grantId,
            consumption,
          )
        : (assertOwned === undefined
            ? consumeCollaborationGrant(
                context.git.gitCommonDirectory,
                grantAuthorization.grantId,
                consumption,
              )
            : consumeCollaborationGrantUnderLifecycleLock(
                context.git.gitCommonDirectory,
                grantAuthorization.grantId,
                consumption,
                assertOwned,
              )
          ).use;
    if (!use) {
      throw workflowError(
        'COLLABORATION_GRANT_ADMISSION_REQUIRED',
        grantAccess === 'replay-consumed'
          ? 'Status cannot admit a reserved collaboration grant; retry the exact mutating propose input.'
          : 'The exact collaboration grant use was not durably consumed.',
        ExitCode.staleState,
      );
    }
    grantUse = use;
    grantAdmission = {
      now,
      expectedBinding: grantAuthorization.expectedBinding,
      policy,
      verifier,
      transitionDigest: grantAuthorization.transitionDigest,
    };
  } else if (grantAuthorization !== null) {
    throw workflowError(
      'PROPOSE_AUTHORIZATION_INVALID',
      'Ordinary survey authorization cannot carry a collaboration grant.',
      ExitCode.staleState,
    );
  }
  return admitRoleResult({
    assignment: request.roleAssignment,
    author,
    participant,
    content,
    providerInvocation: {
      invocationId: request.invocationId,
      requestDigest: request.requestDigest,
      outputDigest: result.outputDigest,
      providerId: request.roleAssignment.providerId,
      sessionId: request.roleAssignment.sessionId,
      targetDigest: request.roleAssignment.targetDigest,
      engineSpawned: true,
    },
    grantUse,
    grantValidation: grantAdmission,
  });
}

function preparePlanningScaffold(
  cwd: string,
  status: InvestigationStatus,
  rebuilt: RebuiltInvestigation,
  createdDate: string,
  allowAuthoredExisting = false,
  materializeScaffold = true,
): {
  changeDirectory: string;
  investigationBytes: string;
  instructions: ProposeWork['authoredInstructions'];
} {
  if (rebuilt.coverageNode === null) {
    throw workflowError(
      'INVESTIGATION_NOT_SEALED',
      'A sealed investigation requires current coverage evidence.',
      ExitCode.guard,
    );
  }
  if (rebuilt.inventoryNode === null) {
    throw workflowError(
      'INVESTIGATION_NOT_SEALED',
      'A sealed investigation requires current inventory evidence.',
      ExitCode.guard,
    );
  }
  const context = loadInvestigationRuntimeContext(cwd);
  const changeDirectory = path.join(
    context.git.repositoryRoot,
    context.config.changeRoot,
    status.changeId,
  );
  const migration = rebuilt.legacyMigration;
  const metadataBytes =
    migration === null
      ? `schema: expense-app-v2\ncreated: ${createdDate}\n`
      : legacyMigrationMetadataBytes(migration);
  const sealNode = createInvestigationSealNode(rebuilt);
  const applicability = createInvestigationApplicability({
    kind: 'sealed-investigation',
    baseline: rebuilt.session.baseline,
    intentDigest: rebuilt.session.intentDigest,
    sealNodeId: sealNode.nodeId,
    sealResultDigest: sealNode.resultDigest,
  });
  const nodes = uniqueNodes([
    rebuilt.authorizationNode,
    ...(rebuilt.providerResultNode === null
      ? []
      : [rebuilt.providerResultNode]),
    ...rebuilt.reviewerTermEvidenceNodes,
    ...rebuilt.contributionNodes,
    ...(rebuilt.termUnionNode === null ? [] : [rebuilt.termUnionNode]),
    rebuilt.inventoryNode,
    ...rebuilt.scanNodes,
    ...rebuilt.hitNodes,
    ...rebuilt.groupNodes,
    ...rebuilt.dispositionNodes,
    rebuilt.coverageNode,
    ...rebuilt.whyNodes,
    sealNode,
  ]);
  const investigation = parseInvestigationArtifact(
    {
      schemaVersion: 1,
      kind: 'investigation-artifact',
      changeId: status.changeId,
      legacyMigration: migration !== null,
      nodes,
      currentRefs: {
        coverage: rebuilt.coverageNode.nodeId,
        sealedInvestigation: sealNode.nodeId,
      },
      applicability,
      ...(() => {
        const roleResults = [
          rebuilt.providerRoleResult,
          rebuilt.reviewerRoleResult,
        ].filter((value): value is AdmittedRoleResult => value !== null);
        return roleResults.length === 0 ? {} : { roleResults };
      })(),
    },
    status.changeId,
  );
  const investigationBytes = `${canonicalJson(investigation)}\n`;
  const scaffoldEntries = new Map([
    ['.openspec.yaml', metadataBytes],
    ['investigation.json', investigationBytes],
  ]);
  if (materializeScaffold) {
    assertPlanningTargetsCompatible(
      changeDirectory,
      scaffoldEntries,
      true,
      allowAuthoredExisting || migration !== null,
      false,
      migration,
    );
    writeManagedEntries(changeDirectory, scaffoldEntries, migration);
  }

  const adapter = createOpenSpecAdapter(context.git.repositoryRoot);
  const proposalInstruction = adapter.instructions(
    status.changeId,
    'expense-app-v2',
    'proposal',
  );
  const instructions = [
    {
      artifactId: 'proposal',
      outputPath: proposalInstruction.outputPath,
      instruction: proposalInstruction.instruction,
      template: proposalInstruction.template,
    },
  ];
  return { changeDirectory, investigationBytes, instructions };
}

function createInvestigationSealNode(
  rebuilt: RebuiltInvestigation,
): EvidenceNode {
  const coverage = rebuilt.coverageNode;
  if (coverage === null) {
    throw workflowError(
      'INVESTIGATION_NOT_SEALED',
      'Investigation coverage is unavailable.',
      ExitCode.guard,
    );
  }
  const provenance: Record<string, string> = { coverage: coverage.nodeId };
  const semantic: Record<string, string> = {
    coverage: coverage.resultDigest,
  };
  provenance.authorization = rebuilt.authorizationNode.nodeId;
  semantic.authorization = rebuilt.authorizationNode.resultDigest;
  if (rebuilt.providerResultNode === null || rebuilt.termUnionNode === null) {
    throw workflowError(
      'INVESTIGATION_NOT_SEALED',
      'Investigation provider and term-union evidence is unavailable.',
      ExitCode.guard,
    );
  }
  provenance['provider-result'] = rebuilt.providerResultNode.nodeId;
  semantic['provider-result'] = rebuilt.providerResultNode.resultDigest;
  provenance['term-union'] = rebuilt.termUnionNode.nodeId;
  semantic['term-union'] = rebuilt.termUnionNode.resultDigest;
  if (rebuilt.reviewerTermSourceNode !== null) {
    provenance['reviewer-term-source'] = rebuilt.reviewerTermSourceNode.nodeId;
    semantic['reviewer-term-source'] =
      rebuilt.reviewerTermSourceNode.resultDigest;
  }
  [...rebuilt.whyNodes]
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId))
    .forEach((node, index) => {
      provenance[`why-${index}`] = node.nodeId;
      semantic[`why-${index}`] = node.resultDigest;
    });
  return createEvidenceNode({
    type: 'sealed-investigation',
    nodeSchema: 'investigation.seal.v1',
    evaluator: 'workflow-propose.v1',
    policyDigest: PROPOSE_POLICY_DIGEST,
    exactInputDigests: {
      intent: rebuilt.session.intentDigest,
      blindManifest: rebuilt.session.blindManifestDigest,
      blindRequest: rebuilt.session.blindRequestDigest,
      blindResult: rebuilt.session.milestones.blindResult!.outputDigest,
      mainTerms: checkpointContributionDigest(
        rebuilt.session.milestones.mainTerms!.envelope,
      ),
      reviewerTermSource:
        rebuilt.session.milestones.reviewerTermSourceNodeId ??
        sha256(canonicalJson(null)),
      groupDispositions: checkpointContributionDigest(
        rebuilt.session.milestones.groupDispositions!.envelope,
      ),
      whyAnswers: checkpointContributionDigest(
        rebuilt.session.milestones.whyAnswers!.envelope,
      ),
    },
    semanticParentResultDigests: semantic,
    provenanceParentNodeIds: provenance,
    outputSchema: 'investigation.seal-output.v1',
    output: {
      sealed: true,
      baseline: rebuilt.session.baseline,
      termSources: rebuilt.termSources,
      floor: rebuilt.floor,
      providerResult: rebuilt.session.milestones.blindResult,
    },
    runtimeMetadata: {},
  });
}

function reconcileReviewerTermPlanningRevision(
  cwd: string,
  status: InvestigationStatus,
  options: ProposeResumeOptions,
): ProposeOutput {
  const initialContext = loadInvestigationRuntimeContext(cwd);
  withInvestigationTransitionAuthority(
    initialContext.lifecycleRuntime,
    status.changeId,
    (assertOwned) => {
      assertOwned();
      const current = getInvestigationStatus(cwd, status.investigationId);
      if (current.state !== 'investigation-sealed') {
        throw workflowError(
          'INVESTIGATION_REVIEWER_REOPEN_STALE',
          'Reviewer-term planning reconciliation requires the resealed investigation.',
          ExitCode.staleState,
        );
      }
      const context = loadInvestigationRuntimeContext(cwd);
      const rebuilt = rebuildInvestigation(
        cwd,
        current.investigationId,
        'consume',
        options.collaborationGrantValidation,
        assertOwned,
      );
      if (rebuilt.reviewerTermSourceNode === null) {
        throw workflowError(
          'INVESTIGATION_REVIEWER_REOPEN_STALE',
          'The resealed investigation has no reviewer-term source.',
          ExitCode.staleState,
        );
      }
      const receipt = readReviewerReconciliationMaterializationReceipt(
        context.runtime,
        current,
      );
      const changeDirectory = path.join(
        context.git.repositoryRoot,
        context.config.changeRoot,
        current.changeId,
      );
      const scaffold = preparePlanningScaffold(
        cwd,
        current,
        rebuilt,
        rebuilt.session.createdAt.slice(0, 10),
        true,
        false,
      );
      // The prior PlanReview reservation/review-root authenticates old bytes,
      // the sealed session projection derives exact next bytes, and the
      // materialization-ref CAS is the commit point. Before that CAS only old
      // or next bytes may exist; after it, retries require exact next bytes and
      // never roll live files back after a downstream error.
      let currentArtifacts: Record<string, string>;
      if (receipt.matchesCurrentSession) {
        const sealedArtifacts = readPlanningMaterializationReceipt(
          context.runtime,
          current,
          createInvestigationSealNode(rebuilt),
        );
        if (sealedArtifacts === null) {
          throw planningMaterializationStale(
            'Reviewer-term reconciliation lost its current materialization.',
          );
        }
        assertOwned();
        const sealedLiveArtifacts = assertReviewerReconciliationLiveArtifacts(
          changeDirectory,
          sealedArtifacts,
          sealedArtifacts,
        );
        const sealedBytes = new Map(
          [...sealedLiveArtifacts.entries()].map(([relativePath, artifact]) => [
            relativePath,
            artifact.text,
          ]),
        );
        reclaimReviewerReconciliationTemporaries(
          changeDirectory,
          sealedBytes,
          sealedBytes,
        );
        assertOwned();
        assertReviewerReconciliationLiveArtifacts(
          changeDirectory,
          sealedArtifacts,
          sealedArtifacts,
        );
        if (
          sealedArtifacts['investigation.json'] !==
          sha256(scaffold.investigationBytes)
        ) {
          throw planningMaterializationStale(
            'Current reviewer-term materialization does not match the resealed investigation.',
          );
        }
        currentArtifacts = sealedArtifacts;
      } else {
        const previousArtifacts = readReviewerReconciliationSnapshotArtifacts(
          context.runtime,
          context.config.changeRoot,
          current,
          receipt,
        );
        const previousDesign = previousArtifacts.get('design.md');
        if (
          previousDesign === undefined ||
          !previousArtifacts.has('investigation.json')
        ) {
          throw planningMaterializationStale(
            'Reviewer-term reconciliation snapshot is missing a managed target.',
          );
        }
        const nextDesign = projectInvestigationLedger(
          previousDesign,
          rebuilt.whyNodes,
        );
        const nextBytes = new Map(previousArtifacts);
        nextBytes.set('investigation.json', scaffold.investigationBytes);
        nextBytes.set('design.md', nextDesign);
        const nextArtifacts = Object.fromEntries(
          [...nextBytes.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([relativePath, content]) => [relativePath, sha256(content)]),
        );
        assertOwned();
        reclaimReviewerReconciliationTemporaries(
          changeDirectory,
          previousArtifacts,
          nextBytes,
        );
        assertOwned();
        const liveArtifacts = assertReviewerReconciliationLiveArtifacts(
          changeDirectory,
          receipt.artifacts,
          nextArtifacts,
        );
        for (const relativePath of ['investigation.json', 'design.md']) {
          const nextContent = nextBytes.get(relativePath);
          const live = liveArtifacts.get(relativePath);
          if (nextContent === undefined || live === undefined) {
            throw planningMaterializationStale(
              'Reviewer-term reconciliation lost a managed target.',
            );
          }
          if (live.digest !== nextArtifacts[relativePath]) {
            replaceTextAtomic(
              path.join(changeDirectory, relativePath),
              nextContent,
              { allowCreate: false },
            );
          }
        }
        assertReviewerReconciliationLiveArtifacts(
          changeDirectory,
          nextArtifacts,
          nextArtifacts,
        );
        fsyncReviewerReconciliationDirectory(changeDirectory);
        persistPlanningMaterializationReceipt(
          context.runtime,
          current,
          createInvestigationSealNode(rebuilt),
          nextArtifacts,
          receipt.nodeId,
        );
        currentArtifacts = nextArtifacts;
      }
      const planning = derivePlanningSubjectFromCurrentDraft(
        cwd,
        current,
        scaffold.investigationBytes,
        currentArtifacts,
      );
      preparePlanReviewInvocation(
        cwd,
        current,
        planning,
        options.collaborationGrant,
        assertOwned,
      );
      assertOwned();
    },
  );
  let output = getProposeStatus(cwd, status.investigationId);
  dispatchPreparedPlanReview(cwd, output, options);
  output = getProposeStatus(cwd, status.investigationId);
  return output;
}

type ReviewerReconciliationMaterializationReceipt = {
  nodeId: string;
  node: EvidenceNode;
  matchesCurrentSession: boolean;
  artifacts: Record<string, string>;
};

function readReviewerReconciliationMaterializationReceipt(
  paths: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  status: InvestigationStatus,
): ReviewerReconciliationMaterializationReceipt {
  const nodeId = readEvidenceRefs(paths, status.changeId)[
    PLANNING_MATERIALIZATION_REF
  ];
  if (!nodeId) {
    throw planningMaterializationStale(
      'Reviewer-term reconciliation has no planning materialization.',
    );
  }
  const node = readEvidenceNode(paths, nodeId);
  const output = node.output;
  const semanticReceipt =
    node.nodeSchema === 'workflow.propose-planning-materialization.v2' &&
    node.outputSchema === 'workflow.propose-planning-materialization-output.v2';
  const legacyReceipt =
    node.nodeSchema === 'workflow.propose-planning-materialization.v1' &&
    node.outputSchema === 'workflow.propose-planning-materialization-output.v1';
  const boundRevision =
    isRecord(output) && semanticReceipt
      ? output.semanticRevision
      : isRecord(output) && legacyReceipt
        ? output.revision
        : null;
  if (
    node.type !== 'propose-planning-materialization' ||
    (!semanticReceipt && !legacyReceipt) ||
    node.evaluator !== 'workflow-propose.v1' ||
    node.policyDigest !== PROPOSE_POLICY_DIGEST ||
    !isRecord(output) ||
    !hasExactKeys(output, [
      'investigationId',
      'changeId',
      semanticReceipt ? 'semanticRevision' : 'revision',
      'baseline',
      'artifacts',
      'sealNodeId',
      'sealResultDigest',
    ]) ||
    output.investigationId !== status.investigationId ||
    output.changeId !== status.changeId ||
    !Number.isSafeInteger(boundRevision) ||
    Number(boundRevision) < 0 ||
    Number(boundRevision) >
      (semanticReceipt ? status.semanticRevision : status.revision) ||
    canonicalJson(output.baseline) !== canonicalJson(status.baseline) ||
    !isDigestRecord(output.artifacts) ||
    typeof output.sealNodeId !== 'string' ||
    !DIGEST.test(output.sealNodeId) ||
    typeof output.sealResultDigest !== 'string' ||
    !DIGEST.test(output.sealResultDigest) ||
    !hasExactKeys(node.exactInputDigests, ['artifacts', 'baseline', 'seal']) ||
    !hasExactKeys(node.provenanceParentNodeIds, ['seal']) ||
    !hasExactKeys(node.semanticParentResultDigests, ['seal']) ||
    node.exactInputDigests.artifacts !==
      sha256(canonicalJson(output.artifacts)) ||
    node.exactInputDigests.baseline !==
      sha256(canonicalJson(status.baseline)) ||
    node.exactInputDigests.seal !== output.sealNodeId ||
    node.provenanceParentNodeIds.seal !== output.sealNodeId ||
    node.semanticParentResultDigests.seal !== output.sealResultDigest
  ) {
    throw planningMaterializationStale(
      'Reviewer-term reconciliation materialization is invalid or stale.',
    );
  }
  return {
    nodeId,
    node,
    matchesCurrentSession:
      Number(boundRevision) ===
      (semanticReceipt ? status.semanticRevision : status.revision),
    artifacts: output.artifacts as Record<string, string>,
  };
}

function readReviewerReconciliationSnapshotArtifacts(
  paths: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  changeRoot: string,
  status: InvestigationStatus,
  receipt: ReviewerReconciliationMaterializationReceipt,
): Map<string, string> {
  const reservation = readPlanReviewReservation(paths, status);
  if (
    reservation === null ||
    reservation.materializationNode.nodeId !== receipt.nodeId ||
    canonicalJson(reservation.materializationNode) !==
      canonicalJson(receipt.node)
  ) {
    throw planningMaterializationStale(
      'Prior PlanReview does not bind the current old materialization.',
    );
  }
  const durableManifest = readProviderInvocationManifest(
    paths,
    reservation.request.invocationId,
  );
  const durableRequest = readProviderInvocationRequest(
    paths,
    reservation.request.invocationId,
  );
  const snapshotRuntime = readPlanReviewSnapshotRuntime(
    paths,
    reservation.request.invocationId,
  );
  if (
    snapshotRuntime === null ||
    canonicalJson(durableManifest) !== canonicalJson(reservation.manifest) ||
    canonicalJson(durableRequest) !== canonicalJson(reservation.request) ||
    canonicalJson(reservation.manifest.planningTarget) !==
      canonicalJson(
        readPlanReviewTargetSnapshotNode(reservation.targetSnapshotNode),
      )
  ) {
    throw planningMaterializationStale(
      'Prior PlanReview snapshot binding is missing or stale.',
    );
  }
  const changePrefix = `${changeRoot}/${status.changeId}/`;
  const artifacts = new Map<string, string>();
  for (const artifact of reservation.manifest.planningTarget.artifacts) {
    if (!artifact.path.startsWith(changePrefix)) {
      throw planningMaterializationStale(
        'Prior PlanReview snapshot contains an unrelated planning path.',
      );
    }
    const relativePath = artifact.path.slice(changePrefix.length);
    if (
      normalizeExactRepositoryPath(relativePath) !== relativePath ||
      artifacts.has(relativePath) ||
      receipt.artifacts[relativePath] !== artifact.sha256
    ) {
      throw planningMaterializationStale(
        'Prior PlanReview snapshot does not exactly cover the old materialization.',
      );
    }
    const content = fs.readFileSync(
      path.join(snapshotRuntime.root, artifact.snapshotFile),
    );
    const text = content.toString('utf8');
    if (
      !Buffer.from(text, 'utf8').equals(content) ||
      content.byteLength !== artifact.byteLength ||
      sha256(content) !== artifact.sha256
    ) {
      throw planningMaterializationStale(
        'Prior PlanReview snapshot bytes are invalid or stale.',
      );
    }
    artifacts.set(relativePath, text);
  }
  if (
    canonicalJson([...artifacts.keys()].sort()) !==
    canonicalJson(Object.keys(receipt.artifacts).sort())
  ) {
    throw planningMaterializationStale(
      'Prior PlanReview snapshot membership differs from the old materialization.',
    );
  }
  return artifacts;
}

function reclaimReviewerReconciliationTemporaries(
  changeDirectory: string,
  oldArtifacts: Map<string, string>,
  nextArtifacts: Map<string, string>,
): void {
  const reclaimable: Array<{
    path: string;
    stats: fs.Stats;
    ownerPid: number;
  }> = [];
  for (const basename of ['design.md', 'investigation.json']) {
    const oldContent = oldArtifacts.get(basename);
    const nextContent = nextArtifacts.get(basename);
    if (oldContent === undefined || nextContent === undefined) {
      throw planningMaterializationStale(
        'Reviewer-term reconciliation lost authenticated temporary content.',
      );
    }
    const oldBytes = Buffer.from(oldContent, 'utf8');
    const nextBytes = Buffer.from(nextContent, 'utf8');
    const prefix = `${basename}.`;
    for (const name of fs.readdirSync(changeDirectory).sort()) {
      if (!name.startsWith(prefix)) {
        continue;
      }
      const match = ATOMIC_TEXT_TEMP_SUFFIX.exec(name.slice(prefix.length));
      if (!match) {
        continue;
      }
      const ownerPid = Number(match[1]);
      if (!Number.isSafeInteger(ownerPid) || ownerPid < 1) {
        throw planningMaterializationStale(
          'Reviewer-term reconciliation found an unsafe atomic replacement temporary.',
        );
      }
      const temporaryPath = path.join(changeDirectory, name);
      const before = fs.lstatSync(temporaryPath, {
        throwIfNoEntry: false,
      });
      if (
        !before ||
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.nlink !== 1 ||
        (before.mode & 0o777) !== 0o644
      ) {
        throw planningMaterializationStale(
          'Reviewer-term reconciliation found an unsafe atomic replacement temporary.',
        );
      }
      let descriptor: number | undefined;
      try {
        descriptor = fs.openSync(
          temporaryPath,
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
        );
        const opened = fs.fstatSync(descriptor);
        const content = fs.readFileSync(descriptor);
        const after = fs.lstatSync(temporaryPath, {
          throwIfNoEntry: false,
        });
        if (
          !after ||
          !after.isFile() ||
          after.isSymbolicLink() ||
          opened.dev !== before.dev ||
          opened.ino !== before.ino ||
          after.dev !== before.dev ||
          after.ino !== before.ino ||
          opened.nlink !== 1 ||
          after.nlink !== 1 ||
          (opened.mode & 0o777) !== 0o644 ||
          (after.mode & 0o777) !== 0o644 ||
          opened.size !== before.size ||
          after.size !== before.size ||
          opened.mtimeMs !== before.mtimeMs ||
          after.mtimeMs !== before.mtimeMs ||
          opened.ctimeMs !== before.ctimeMs ||
          after.ctimeMs !== before.ctimeMs ||
          content.byteLength !== before.size ||
          reviewerReconciliationTemporaryOwnerIsAlive(ownerPid) ||
          !isReviewerReconciliationTemporaryPrefix(content, oldBytes, nextBytes)
        ) {
          throw planningMaterializationStale(
            'Reviewer-term reconciliation found an unsafe atomic replacement temporary.',
          );
        }
      } catch (error) {
        if (
          isRecord(error) &&
          error.code === 'PLANNING_MATERIALIZATION_STALE'
        ) {
          throw error;
        }
        throw planningMaterializationStale(
          'Reviewer-term reconciliation could not inspect an atomic replacement temporary.',
        );
      } finally {
        if (descriptor !== undefined) {
          fs.closeSync(descriptor);
        }
      }
      reclaimable.push({ path: temporaryPath, stats: before, ownerPid });
    }
  }
  let removed = false;
  for (const entry of reclaimable) {
    const current = fs.lstatSync(entry.path, { throwIfNoEntry: false });
    if (!current) {
      continue;
    }
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.nlink !== 1 ||
      (current.mode & 0o777) !== 0o644 ||
      current.dev !== entry.stats.dev ||
      current.ino !== entry.stats.ino ||
      reviewerReconciliationTemporaryOwnerIsAlive(entry.ownerPid)
    ) {
      throw planningMaterializationStale(
        'Reviewer-term reconciliation atomic replacement temporary changed before reclamation.',
      );
    }
    fs.unlinkSync(entry.path);
    removed = true;
  }
  if (removed) {
    fsyncReviewerReconciliationDirectory(changeDirectory);
  }
}

function isReviewerReconciliationTemporaryPrefix(
  content: Buffer,
  oldContent: Buffer,
  nextContent: Buffer,
): boolean {
  return (
    (content.byteLength <= oldContent.byteLength &&
      oldContent.subarray(0, content.byteLength).equals(content)) ||
    (content.byteLength <= nextContent.byteLength &&
      nextContent.subarray(0, content.byteLength).equals(content))
  );
}

function reviewerReconciliationTemporaryOwnerIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isRecord(error) || error.code !== 'ESRCH';
  }
}

function fsyncReviewerReconciliationDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    if (!fs.fstatSync(descriptor).isDirectory()) {
      throw planningMaterializationStale(
        'Reviewer-term reconciliation change directory is unsafe.',
      );
    }
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertReviewerReconciliationLiveArtifacts(
  changeDirectory: string,
  oldArtifacts: Record<string, string>,
  nextArtifacts: Record<string, string>,
): Map<string, { digest: string; text: string }> {
  if (
    canonicalJson(Object.keys(oldArtifacts).sort()) !==
    canonicalJson(Object.keys(nextArtifacts).sort())
  ) {
    throw planningMaterializationStale(
      'Reviewer-term reconciliation artifact membership changed.',
    );
  }
  const observed = new Map<string, { digest: string; text: string }>();
  for (const relativePath of Object.keys(oldArtifacts).sort()) {
    const normalized = normalizePolicyPath(relativePath);
    if (normalized !== relativePath) {
      throw planningMaterializationStale(
        'Reviewer-term reconciliation found a non-canonical artifact path.',
      );
    }
    const target = path.join(changeDirectory, normalized);
    const stats = fs.lstatSync(target, { throwIfNoEntry: false });
    if (
      !stats?.isFile() ||
      stats.isSymbolicLink() ||
      stats.nlink !== 1 ||
      (stats.mode & 0o777) !== 0o644
    ) {
      throw planningMaterializationStale(
        'Reviewer-term reconciliation found an unsafe planning artifact.',
      );
    }
    const content = fs.readFileSync(target);
    const text = content.toString('utf8');
    const digest = sha256(content);
    if (
      !Buffer.from(text, 'utf8').equals(content) ||
      (digest !== oldArtifacts[relativePath] &&
        digest !== nextArtifacts[relativePath])
    ) {
      throw planningMaterializationStale(
        'Planning bytes contain neither the authenticated old nor exact next materialization.',
      );
    }
    observed.set(relativePath, { digest, text });
  }
  return observed;
}

function derivePlanningSubjectFromCurrentDraft(
  cwd: string,
  status: InvestigationStatus,
  investigationBytes: string,
  artifactDigestMap: Record<string, string>,
): InvestigationFirstPlanningSubject {
  const context = loadInvestigationRuntimeContext(cwd);
  const changeDirectory = path.join(
    context.git.repositoryRoot,
    context.config.changeRoot,
    status.changeId,
  );
  const tasks = parseTasks(
    fs.readFileSync(path.join(changeDirectory, 'tasks.md'), 'utf8'),
  );
  const guard = assertGuardContribution(
    JSON.parse(
      fs.readFileSync(path.join(changeDirectory, 'guard.json'), 'utf8'),
    ),
    status.changeId,
    tasks.map(({ id }) => id),
    Object.keys(loadChecksConfig(context.git.repositoryRoot).checks),
  );
  const specs = Object.keys(artifactDigestMap)
    .filter((relativePath) => relativePath.startsWith('specs/'))
    .sort()
    .map((relativePath) => ({
      path: relativePath,
      content: fs.readFileSync(
        path.join(changeDirectory, relativePath),
        'utf8',
      ),
    }));
  const behaviorContracts = indexBehaviorContracts(specs);
  const execution = parseExecutionArtifact(
    JSON.parse(
      fs.readFileSync(path.join(changeDirectory, 'execution.json'), 'utf8'),
    ),
    status.changeId,
    tasks,
    guard,
    loadChecksConfig(context.git.repositoryRoot),
    behaviorContracts,
  );
  const investigation = parseInvestigationArtifact(
    JSON.parse(investigationBytes),
    status.changeId,
  );
  const checks = loadChecksConfig(context.git.repositoryRoot);
  const contract: ChangeContract = {
    changeId: status.changeId,
    changeDirectory,
    schemaName: 'expense-app-v2',
    config: context.config,
    checks,
    guard,
    tasks,
    behaviorContracts,
    investigation,
    execution,
    artifactPaths: Object.keys(artifactDigestMap).map((relativePath) =>
      path.join(changeDirectory, relativePath),
    ),
    artifactDigests: Object.fromEntries(
      Object.entries(artifactDigestMap).map(([relativePath, digest]) => [
        path.join(changeDirectory, relativePath),
        digest,
      ]),
    ),
  };
  return deriveInvestigationFirstPlanningSubject(
    context.git.repositoryRoot,
    contract,
  );
}

function materializePlanningContribution(
  cwd: string,
  status: InvestigationStatus,
  rebuilt: RebuiltInvestigation,
  payloadInput: unknown,
  collaborationGrant?: ProposeResumeOptions['collaborationGrant'],
  assertOwned: () => void = () => {},
): Record<string, string> {
  const payload = assertPlanningPayload(payloadInput);
  const scaffold = preparePlanningScaffold(
    cwd,
    status,
    rebuilt,
    rebuilt.session.createdAt.slice(0, 10),
    true,
  );
  const context = loadInvestigationRuntimeContext(cwd);
  const migration = rebuilt.legacyMigration;
  const tasks = parseTasks(payload.tasks);
  if (
    tasks.length === 0 ||
    (migration === null && tasks.some(({ completed }) => completed))
  ) {
    throw planningContributionInvalid(
      'Planning tasks must be non-empty and unchecked.',
    );
  }
  const guard = assertGuardContribution(
    payload.guard,
    status.changeId,
    tasks.map(({ id }) => id),
    Object.keys(loadChecksConfig(context.git.repositoryRoot).checks),
  );
  const behaviorContracts = indexBehaviorContracts(payload.specs);
  const execution = parseExecutionArtifact(
    {
      schemaVersion: 1,
      kind: 'execution-artifact',
      changeId: status.changeId,
      tasks: payload.executionTasks,
    },
    status.changeId,
    tasks,
    guard,
    loadChecksConfig(context.git.repositoryRoot),
    behaviorContracts,
  );
  const projectedDesign = projectInvestigationLedger(
    payload.design,
    rebuilt.whyNodes,
  );
  const entries = new Map<string, string>([
    [
      '.openspec.yaml',
      migration === null
        ? `schema: expense-app-v2\ncreated: ${rebuilt.session.createdAt.slice(0, 10)}\n`
        : legacyMigrationMetadataBytes(migration),
    ],
    ['investigation.json', scaffold.investigationBytes],
    ['proposal.md', assertAuthoredMarkdown(payload.proposal, 'proposal')],
    ['design.md', projectedDesign],
    ['tasks.md', assertAuthoredMarkdown(payload.tasks, 'tasks')],
    ['guard.json', `${canonicalJson(guard)}\n`],
    ['execution.json', `${canonicalJson(execution)}\n`],
  ]);
  for (const spec of assertSpecContributions(payload.specs)) {
    entries.set(spec.path, spec.content);
  }
  if (migration !== null) {
    assertPreservedLegacyProjection({
      subject: migration,
      tasks,
      guard,
      entries,
    });
  }

  const digests = artifactDigests(entries);
  const sealNode = createInvestigationSealNode(rebuilt);
  const existingReceipt = readPlanningMaterializationReceipt(
    context.runtime,
    status,
    sealNode,
  );
  if (
    existingReceipt !== null &&
    canonicalJson(existingReceipt) !== canonicalJson(digests)
  ) {
    throw workflowError(
      'PLANNING_MATERIALIZATION_CONFLICT',
      'A different planning materialization is already current.',
      ExitCode.conflict,
    );
  }
  assertPlanningTargetsCompatible(
    scaffold.changeDirectory,
    entries,
    false,
    false,
    false,
    migration,
  );
  const createdPaths: string[] = [];
  const replacedBytes = new Map<string, string>();
  try {
    for (const [relativePath, content] of entries) {
      const target = path.join(scaffold.changeDirectory, relativePath);
      if (fs.existsSync(target)) {
        const stats = fs.lstatSync(target);
        const existing =
          stats.isFile() && !stats.isSymbolicLink()
            ? fs.readFileSync(target, 'utf8')
            : null;
        if (existing === content) {
          continue;
        }
        if (
          existing === null ||
          migration === null ||
          !isReplaceableLegacyArtifact(migration, relativePath, existing)
        ) {
          throw workflowError(
            'UNMANAGED_PLANNING_CONFLICT',
            'Planning bytes changed during managed materialization.',
            ExitCode.conflict,
          );
        }
        replaceTextAtomic(target, content, { defaultMode: 0o644 });
        replacedBytes.set(target, existing);
        continue;
      }
      replaceTextAtomic(target, content, {
        allowCreate: true,
        defaultMode: 0o644,
      });
      createdPaths.push(target);
    }
    const adapter = createOpenSpecAdapter(context.git.repositoryRoot);
    const statusPayload = adapter.status(status.changeId, 'expense-app-v2');
    const planReview = statusPayload.artifacts.find(
      ({ id }) => id === 'plan-review',
    );
    if (
      statusPayload.isComplete ||
      planReview?.status !== 'ready' ||
      statusPayload.artifacts.some(
        ({ id, status: artifactStatus }) =>
          id !== 'plan-review' && artifactStatus !== 'done',
      )
    ) {
      throw planningContributionInvalid(
        'OpenSpec did not observe the expected review-pending planning graph.',
      );
    }
    assertPlanningTargetsCompatible(scaffold.changeDirectory, entries, false);
    persistPlanningMaterializationReceipt(
      context.runtime,
      status,
      sealNode,
      digests,
    );
    const investigation = parseInvestigationArtifact(
      JSON.parse(scaffold.investigationBytes),
      status.changeId,
    );
    const checks = loadChecksConfig(context.git.repositoryRoot);
    const draftContract: ChangeContract = {
      changeId: status.changeId,
      changeDirectory: scaffold.changeDirectory,
      schemaName: 'expense-app-v2',
      config: context.config,
      checks,
      guard,
      tasks,
      behaviorContracts,
      investigation,
      execution,
      artifactPaths: [...entries.keys()].map((relativePath) =>
        path.join(scaffold.changeDirectory, relativePath),
      ),
      artifactDigests: Object.fromEntries(
        Object.entries(digests).map(([relativePath, digest]) => [
          path.join(scaffold.changeDirectory, relativePath),
          digest,
        ]),
      ),
    };
    const planningSubject = deriveInvestigationFirstPlanningSubject(
      context.git.repositoryRoot,
      draftContract,
    );
    preparePlanReviewInvocation(
      cwd,
      status,
      planningSubject,
      collaborationGrant,
      assertOwned,
    );
  } catch (error) {
    for (const target of createdPaths.reverse()) {
      fs.rmSync(target, { force: true });
    }
    for (const [target, previous] of replacedBytes) {
      replaceTextAtomic(target, previous, { defaultMode: 0o644 });
    }
    throw error;
  }
  return digests;
}

function materializeExemptionPlanningContribution(
  cwd: string,
  session: ProposeExemptionSession,
  payloadInput: unknown,
  collaborationGrant?: ProposeResumeOptions['collaborationGrant'],
  assertOwned: () => void = () => {},
): Record<string, string> {
  const payload = assertPlanningPayload(payloadInput);
  const scaffold = prepareExemptionPlanningScaffold(cwd, session, true);
  const context = loadInvestigationRuntimeContext(cwd);
  const tasks = parseTasks(payload.tasks);
  if (tasks.length === 0 || tasks.some(({ completed }) => completed)) {
    throw planningContributionInvalid(
      'Planning tasks must be non-empty and unchecked.',
    );
  }
  const guard = assertGuardContribution(
    payload.guard,
    session.changeId,
    tasks.map(({ id }) => id),
    Object.keys(loadChecksConfig(context.git.repositoryRoot).checks),
  );
  const behaviorContracts = indexBehaviorContracts(payload.specs);
  const execution = parseExecutionArtifact(
    {
      schemaVersion: 1,
      kind: 'execution-artifact',
      changeId: session.changeId,
      tasks: payload.executionTasks,
    },
    session.changeId,
    tasks,
    guard,
    loadChecksConfig(context.git.repositoryRoot),
    behaviorContracts,
  );
  const entries = new Map<string, string>([
    [
      '.openspec.yaml',
      `schema: expense-app-v2\ncreated: ${session.createdAt.slice(0, 10)}\n`,
    ],
    ['investigation.json', scaffold.investigationBytes],
    ['proposal.md', assertAuthoredMarkdown(payload.proposal, 'proposal')],
    ['design.md', assertAuthoredMarkdown(payload.design, 'design')],
    ['tasks.md', assertAuthoredMarkdown(payload.tasks, 'tasks')],
    ['guard.json', `${canonicalJson(guard)}\n`],
    ['execution.json', `${canonicalJson(execution)}\n`],
  ]);
  for (const spec of assertSpecContributions(payload.specs)) {
    entries.set(spec.path, spec.content);
  }

  const digests = artifactDigests(entries);
  const existingReceipt = readExemptionPlanningMaterializationReceipt(
    context.runtime,
    session,
  );
  if (
    existingReceipt !== null &&
    canonicalJson(existingReceipt) !== canonicalJson(digests)
  ) {
    throw workflowError(
      'PLANNING_MATERIALIZATION_CONFLICT',
      'A different planning materialization is already current.',
      ExitCode.conflict,
    );
  }
  assertPlanningTargetsCompatible(scaffold.changeDirectory, entries, false);
  const createdPaths: string[] = [];
  try {
    for (const [relativePath, content] of entries) {
      const target = path.join(scaffold.changeDirectory, relativePath);
      if (fs.existsSync(target)) {
        const stats = fs.lstatSync(target);
        if (
          !stats.isFile() ||
          stats.isSymbolicLink() ||
          fs.readFileSync(target, 'utf8') !== content
        ) {
          throw workflowError(
            'UNMANAGED_PLANNING_CONFLICT',
            'Planning bytes changed during managed materialization.',
            ExitCode.conflict,
          );
        }
        continue;
      }
      replaceTextAtomic(target, content, {
        allowCreate: true,
        defaultMode: 0o644,
      });
      createdPaths.push(target);
    }
    const adapter = createOpenSpecAdapter(context.git.repositoryRoot);
    const statusPayload = adapter.status(session.changeId, 'expense-app-v2');
    const planReview = statusPayload.artifacts.find(
      ({ id }) => id === 'plan-review',
    );
    if (
      statusPayload.isComplete ||
      planReview?.status !== 'ready' ||
      statusPayload.artifacts.some(
        ({ id, status: artifactStatus }) =>
          id !== 'plan-review' && artifactStatus !== 'done',
      )
    ) {
      throw planningContributionInvalid(
        'OpenSpec did not observe the expected review-pending planning graph.',
      );
    }
    assertPlanningTargetsCompatible(scaffold.changeDirectory, entries, false);
    persistExemptionPlanningMaterializationReceipt(
      context.runtime,
      session,
      digests,
    );
    const investigation = parseInvestigationArtifact(
      JSON.parse(scaffold.investigationBytes),
      session.changeId,
    );
    const checks = loadChecksConfig(context.git.repositoryRoot);
    const draftContract: ChangeContract = {
      changeId: session.changeId,
      changeDirectory: scaffold.changeDirectory,
      schemaName: 'expense-app-v2',
      config: context.config,
      checks,
      guard,
      tasks,
      behaviorContracts,
      investigation,
      execution,
      artifactPaths: [...entries.keys()].map((relativePath) =>
        path.join(scaffold.changeDirectory, relativePath),
      ),
      artifactDigests: Object.fromEntries(
        Object.entries(digests).map(([relativePath, digest]) => [
          path.join(scaffold.changeDirectory, relativePath),
          digest,
        ]),
      ),
    };
    const planningSubject = deriveInvestigationFirstPlanningSubject(
      context.git.repositoryRoot,
      draftContract,
    );
    preparePlanReviewInvocation(
      cwd,
      session,
      planningSubject,
      collaborationGrant,
      assertOwned,
    );
  } catch (error) {
    for (const target of createdPaths.reverse()) {
      fs.rmSync(target, { force: true });
    }
    throw error;
  }
  return digests;
}

function persistPlanningMaterializationReceipt(
  paths: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  status: InvestigationStatus,
  sealNode: EvidenceNode,
  artifacts: Record<string, string>,
  expectedCurrentNodeId?: string,
): void {
  const node = createEvidenceNode({
    type: 'propose-planning-materialization',
    nodeSchema: 'workflow.propose-planning-materialization.v2',
    evaluator: 'workflow-propose.v1',
    policyDigest: PROPOSE_POLICY_DIGEST,
    exactInputDigests: {
      artifacts: sha256(canonicalJson(artifacts)),
      baseline: sha256(canonicalJson(status.baseline)),
      seal: sealNode.nodeId,
    },
    semanticParentResultDigests: {
      seal: sealNode.resultDigest,
    },
    provenanceParentNodeIds: {
      seal: sealNode.nodeId,
    },
    outputSchema: 'workflow.propose-planning-materialization-output.v2',
    output: {
      investigationId: status.investigationId,
      changeId: status.changeId,
      semanticRevision: status.semanticRevision,
      baseline: status.baseline,
      artifacts,
      sealNodeId: sealNode.nodeId,
      sealResultDigest: sealNode.resultDigest,
    },
    runtimeMetadata: {},
  });
  writeEvidenceNode(paths, node);
  const current =
    readEvidenceRefs(paths, status.changeId)[PLANNING_MATERIALIZATION_REF] ??
    null;
  if (current === node.nodeId) {
    return;
  }
  if (
    expectedCurrentNodeId !== undefined &&
    current !== expectedCurrentNodeId
  ) {
    throw planningMaterializationStale(
      'Reviewer-term reconciliation materialization changed before receipt advancement.',
    );
  }
  const reviewerRevision =
    readInvestigationSession(paths, status.investigationId).milestones
      .reviewerTermSourceNodeId !== null;
  if (current !== null && !reviewerRevision) {
    throw workflowError(
      'PLANNING_MATERIALIZATION_CONFLICT',
      'A different planning materialization is already current.',
      ExitCode.conflict,
    );
  }
  compareAndSwapEvidenceRef(paths, {
    changeId: status.changeId,
    refName: PLANNING_MATERIALIZATION_REF,
    expectedNodeId: expectedCurrentNodeId ?? current,
    nextNodeId: node.nodeId,
  });
}

function persistExemptionPlanningMaterializationReceipt(
  paths: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  session: ProposeExemptionSession,
  artifacts: Record<string, string>,
): void {
  const applicabilityNode = session.applicabilityNode;
  const node = createEvidenceNode({
    type: 'propose-exemption-planning-materialization',
    nodeSchema: 'workflow.propose-exemption-planning-materialization.v1',
    evaluator: 'workflow-propose.v1',
    policyDigest: PROPOSE_POLICY_DIGEST,
    exactInputDigests: {
      artifacts: sha256(canonicalJson(artifacts)),
      baseline: sha256(canonicalJson(session.baseline)),
      applicability: applicabilityNode.nodeId,
    },
    semanticParentResultDigests: {
      applicability: applicabilityNode.resultDigest,
    },
    provenanceParentNodeIds: {
      applicability: applicabilityNode.nodeId,
    },
    outputSchema:
      'workflow.propose-exemption-planning-materialization-output.v1',
    output: {
      investigationId: session.investigationId,
      changeId: session.changeId,
      revision: session.revision,
      baseline: session.baseline,
      artifacts,
      applicabilityNodeId: applicabilityNode.nodeId,
      applicabilityResultDigest: applicabilityNode.resultDigest,
    },
    runtimeMetadata: {},
  });
  writeEvidenceNode(paths, node);
  const current =
    readEvidenceRefs(paths, session.changeId)[PLANNING_MATERIALIZATION_REF] ??
    null;
  if (current === node.nodeId) {
    return;
  }
  if (current !== null) {
    throw workflowError(
      'PLANNING_MATERIALIZATION_CONFLICT',
      'A different planning materialization is already current.',
      ExitCode.conflict,
    );
  }
  compareAndSwapEvidenceRef(paths, {
    changeId: session.changeId,
    refName: PLANNING_MATERIALIZATION_REF,
    expectedNodeId: null,
    nextNodeId: node.nodeId,
  });
}

type PlanReviewReservation = {
  reservationNode: EvidenceNode;
  planning: InvestigationFirstPlanningSubject;
  subject: PlanReviewSubject;
  assignment: ProviderRoleAssignment;
  author: RecordedRoleParticipant;
  materializationNode: EvidenceNode;
  targetSnapshotNode: EvidenceNode;
  manifest: PlanReviewManifest & {
    planningTarget: PlanReviewTargetSnapshot;
  };
  request: ProviderInvocationRequest;
  grantAuthorization: ProposeGrantAuthorization | null;
  retry: {
    attempt: number;
    previousReservationNodeId: string;
    failedInvocation: PlanReviewRetryEnvelope['failedInvocation'];
    retryDecision: ProviderRetryDecisionBinding | null;
    executionPolicySnapshot: ProviderExecutionPolicySnapshotCurrent | null;
  } | null;
};

type PlanReviewGrantRequirement = {
  subject: PlanReviewSubject;
  author: RecordedRoleParticipant;
  grantRequest: CollaborationGrantRequest | null;
};

function durablePlanReviewMandateBinding(
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  status: ProposeLifecycleStatus,
): TaskMandateBinding | undefined {
  if (status.state === 'investigation-exempt') {
    const session = readProposeExemptionSession(
      context.runtime,
      status.investigationId,
    );
    if (
      session.changeId !== status.changeId ||
      canonicalJson(session.baseline) !== canonicalJson(status.baseline)
    ) {
      throw workflowError(
        'TASK_MANDATE_BINDING_STALE',
        'The exempt PlanReview owner no longer matches the durable planning context.',
        ExitCode.staleState,
      );
    }
    return session.mandateBinding;
  }
  const session = readInvestigationSession(
    context.runtime,
    status.investigationId,
  );
  if (
    session.changeId !== status.changeId ||
    canonicalJson(session.baseline) !== canonicalJson(status.baseline)
  ) {
    throw workflowError(
      'TASK_MANDATE_BINDING_STALE',
      'The PlanReview owner session no longer matches the durable planning context.',
      ExitCode.staleState,
    );
  }
  return session.mandateBinding;
}

function authorizePlanReviewReservationMandate(
  cwd: string,
  binding: TaskMandateBinding | undefined,
  reservation: PlanReviewReservation,
  assertOwned: () => void,
): void {
  if (binding === undefined) return;
  authorizeTaskMandateProviderReservationUnderLifecycleLock(
    cwd,
    binding,
    reservation.request.invocationId,
    {
      providerId: reservation.request.providerId,
      dataTypes: ['diff', 'repository-metadata', 'source-code', 'test-output'],
      sourceCode: true,
      secrets: false,
      retry: reservation.retry !== null,
      budget: null,
      requestDigest: reservation.request.requestDigest,
    },
    assertOwned,
  );
}

function preparePlanReviewInvocation(
  cwd: string,
  status: ProposeLifecycleStatus,
  planning: InvestigationFirstPlanningSubject,
  collaborationGrant: ProposeResumeOptions['collaborationGrant'] | undefined,
  assertOwned: () => void,
): PlanReviewReservation | null {
  const context = loadInvestigationRuntimeContext(cwd);
  const mandateBinding = durablePlanReviewMandateBinding(context, status);
  if (mandateBinding) {
    assertActiveTaskMandateBindingUnderLifecycleLock(
      cwd,
      mandateBinding,
      assertOwned,
    );
  }
  const currentRefs = readEvidenceRefs(context.runtime, status.changeId);
  const existing = readPlanReviewReservation(
    context.runtime,
    status,
    undefined,
    true,
  );
  if (
    existing !== null &&
    canonicalJson(existing.subject) === canonicalJson(planning.subject) &&
    existing.materializationNode.nodeId ===
      currentRefs[PLANNING_MATERIALIZATION_REF]
  ) {
    authorizePlanReviewReservationMandate(
      cwd,
      mandateBinding,
      existing,
      assertOwned,
    );
    ensurePlanReviewInvocation(
      context.git.repositoryRoot,
      context.runtime,
      status,
      existing,
      mandateBinding,
    );
    return existing;
  }
  const expectedReservationNodeId =
    currentRefs[PLAN_REVIEW_REQUEST_REF] ?? null;

  const author = planAuthor(context.runtime, status);
  const recordedAuthor: RecordedRoleParticipant = {
    providerId: author.providerId ?? null,
    sessionId: author.sessionId ?? null,
    principalId: author.principalId ?? null,
    identityAssurance: author.identityAssurance,
    engineSpawned: author.engineSpawned,
  };
  const policy = loadAiAdapterPolicy(context.git.repositoryRoot);
  const providerSessionId = createRuntimeId('provider-session');
  const scheduled = scheduleOrdinaryRole({
    role: 'plan-reviewer',
    author,
    targetDigest: planning.subject.subjectDigest,
    candidates: (['codex', 'claude'] as const).map((providerId) => ({
      providerId,
      sessionId:
        providerId === author.providerId
          ? `author-${providerSessionId}`
          : providerSessionId,
      enabled: policy.policy.providers[providerId].enabled,
      available: policy.policy.providers[providerId].enabled,
    })),
  });
  const callableProviderIds = (['codex', 'claude'] as const).filter(
    (providerId) => policy.policy.providers[providerId].enabled,
  );
  const grantRequest = planReviewGrantRequest({
    changeId: status.changeId,
    baseline: status.baseline,
    targetDigest: planning.subject.subjectDigest,
    author,
    callableProviderIds,
  });
  let assignment: ProviderRoleAssignment;
  let grantAuthorization: ProposeGrantAuthorization | null = null;
  if (scheduled.outcome === 'assigned') {
    assignment = scheduled.assignment;
  } else if (!collaborationGrant) {
    persistPlanReviewGrantRequirement(context.runtime, status, {
      subject: planning.subject,
      author: recordedAuthor,
      grantRequest,
    });
    return null;
  } else {
    if (grantRequest === null) {
      throw workflowError(
        'COLLABORATION_GRANT_FORM_REQUIRED',
        'No provider is callable; submit an explicitly typed caller-supplied or direct-human PlanReview grant.',
        ExitCode.guard,
      );
    }
    const expectedBinding = deriveCollaborationGrantBinding(
      context.git.repositoryRoot,
      grantRequest,
    );
    const transitionDigest = collaborationTransitionDigest(expectedBinding);
    const reservation = reserveCollaborationGrantUnderLifecycleLock(
      context.git.repositoryRoot,
      collaborationGrant.grantId,
      {
        transitionDigest,
        expected: expectedBinding,
        ...(collaborationGrant.now === undefined
          ? {}
          : { now: collaborationGrant.now }),
        ...(collaborationGrant.verifier === undefined
          ? {}
          : { verifier: collaborationGrant.verifier }),
      },
      assertOwned,
    );
    assignment = authorizeGrantedOrdinaryRole({
      role: 'plan-reviewer',
      author,
      targetDigest: planning.subject.subjectDigest,
      reservation,
      actualParticipant: {
        providerId: author.providerId,
        sessionId: providerSessionId,
        principalId: undefined,
        identityAssurance: author.identityAssurance,
        engineSpawned: true,
      },
      callableProviderIds,
    }) as GrantedSameProviderRoleAssignment;
    grantAuthorization = {
      grantId: reservation.grantId,
      transitionDigest,
      expectedBinding,
    };
  }
  const materializationNodeId = currentRefs[PLANNING_MATERIALIZATION_REF];
  if (!materializationNodeId) {
    throw workflowError(
      'PLANNING_MATERIALIZATION_STALE',
      'Plan review requires current planning materialization evidence.',
      ExitCode.staleState,
    );
  }
  const materializationNode = readEvidenceNode(
    context.runtime,
    materializationNodeId,
  );
  const materializationOutput = materializationNode.output;
  if (
    !isRecord(materializationOutput) ||
    !isDigestRecord(materializationOutput.artifacts)
  ) {
    throw workflowError(
      'PLANNING_MATERIALIZATION_STALE',
      'Plan review requires valid current planning materialization evidence.',
      ExitCode.staleState,
    );
  }
  const changePrefix = `${context.config.changeRoot}/${status.changeId}`;
  const snapshotContents = new Map<string, Buffer>();
  for (const [relativePath, expectedDigest] of Object.entries(
    materializationOutput.artifacts,
  ).sort(([left], [right]) => left.localeCompare(right))) {
    let normalizedRelativePath: string;
    try {
      normalizedRelativePath = normalizeExactRepositoryPath(relativePath);
    } catch {
      throw workflowError(
        'PLANNING_MATERIALIZATION_STALE',
        'Plan review materialization contains an unsafe artifact path.',
        ExitCode.staleState,
      );
    }
    if (normalizedRelativePath !== relativePath) {
      throw workflowError(
        'PLANNING_MATERIALIZATION_STALE',
        'Plan review materialization contains a non-canonical artifact path.',
        ExitCode.staleState,
      );
    }
    const target = path.join(
      context.git.repositoryRoot,
      changePrefix,
      normalizedRelativePath,
    );
    const stats = fs.lstatSync(target, { throwIfNoEntry: false });
    if (
      !stats?.isFile() ||
      stats.isSymbolicLink() ||
      stats.nlink !== 1 ||
      (stats.mode & 0o777) !== 0o644
    ) {
      throw workflowError(
        'PLANNING_MATERIALIZATION_STALE',
        'Plan review target contains an unsafe planning artifact.',
        ExitCode.staleState,
      );
    }
    const content = fs.readFileSync(target);
    if (sha256(content) !== expectedDigest) {
      throw workflowError(
        'PLANNING_MATERIALIZATION_STALE',
        'Plan review target bytes differ from materialization evidence.',
        ExitCode.staleState,
      );
    }
    snapshotContents.set(normalizedRelativePath, content);
  }
  const legacyMigration =
    status.state === 'investigation-exempt'
      ? null
      : rebuildInvestigation(
          cwd,
          status.investigationId,
          'consume',
          undefined,
          assertOwned,
        ).legacyMigration;
  const targetSnapshotNode = createPlanReviewTargetSnapshotNode({
    changeId: status.changeId,
    changePrefix,
    subject: planning.subject,
    materializationNode,
    artifacts: snapshotContents,
    legacyMigration,
  });
  writeEvidenceNode(context.runtime, targetSnapshotNode);
  const planningTarget = readPlanReviewTargetSnapshotNode(targetSnapshotNode);
  const reviewAuthorization = createEvidenceNode({
    type: 'plan-review-authorization',
    nodeSchema: 'workflow.plan-review-authorization.v1',
    evaluator: 'workflow-propose.v1',
    policyDigest: PROPOSE_POLICY_DIGEST,
    exactInputDigests: {
      subject: planning.subject.subjectDigest,
      generation: planning.generation.planningGenerationId,
      assignment: sha256(canonicalJson(assignment)),
      grantAuthorization: sha256(canonicalJson(grantAuthorization)),
      targetSnapshot: targetSnapshotNode.nodeId,
    },
    semanticParentResultDigests: {
      materialization: materializationNode.resultDigest,
      targetSnapshot: targetSnapshotNode.resultDigest,
    },
    provenanceParentNodeIds: {
      materialization: materializationNodeId,
      targetSnapshot: targetSnapshotNode.nodeId,
    },
    outputSchema: 'workflow.plan-review-authorization-output.v1',
    output: {
      subject: planning.subject,
      assignment,
      author: recordedAuthor,
      grantAuthorization,
    },
    runtimeMetadata: {},
  });
  writeEvidenceNode(context.runtime, reviewAuthorization);
  const invocationId = createRuntimeId('invocation');
  const manifest: PlanReviewManifest & {
    planningTarget: PlanReviewTargetSnapshot;
  } = {
    schemaVersion: 1,
    kind: 'plan-review-manifest',
    changeId: status.changeId,
    repositoryId: context.config.repositoryName,
    baseCommit: status.baseline.head,
    baseTree: status.baseline.tree,
    subject: planning.subject,
    planningTarget,
    capabilityProfile: 'repository-read-only',
  };
  const request = createProviderInvocationRequest({
    invocationId,
    nonce: `plan-review-${crypto.randomUUID()}`,
    purpose: 'plan-review',
    providerId: assignment.providerId,
    roleAssignment: assignment,
    capabilityProfile: 'repository-read-only',
    repositoryId: context.config.repositoryName,
    baseCommit: status.baseline.head,
    baseTree: status.baseline.tree,
    targetDigest: planning.subject.subjectDigest,
    inputManifestDigest: providerInvocationManifestDigest(manifest),
    authorizationNodeId: reviewAuthorization.nodeId,
    writeAllowedPaths: [],
    outputSchema: PLAN_REVIEW_OUTPUT_SCHEMA,
    evaluatorVersion: 'plan-review.v2',
    policyDigest: policy.digest,
    limits: {
      timeoutMs: policy.policy.limits.timeoutMs,
      aggregateOutputBytes: policy.policy.limits.aggregateOutputBytes,
    },
  });
  const reservationNode = createEvidenceNode({
    type: 'plan-review-request-reservation',
    nodeSchema: 'workflow.plan-review-request-reservation.v1',
    evaluator: 'workflow-propose.v1',
    policyDigest: PROPOSE_POLICY_DIGEST,
    exactInputDigests: {
      request: request.requestDigest,
      manifest: request.inputManifestDigest,
      subject: planning.subject.subjectDigest,
      targetSnapshot: targetSnapshotNode.nodeId,
    },
    semanticParentResultDigests: {
      authorization: reviewAuthorization.resultDigest,
    },
    provenanceParentNodeIds: { authorization: reviewAuthorization.nodeId },
    outputSchema: 'workflow.plan-review-request-reservation-output.v1',
    output: {
      investigationId: status.investigationId,
      changeId: status.changeId,
      planning,
      subject: planning.subject,
      assignment,
      author: recordedAuthor,
      materializationNode,
      targetSnapshotNode,
      manifest,
      request,
      grantAuthorization,
    },
    runtimeMetadata: {},
  });
  storeProviderExecutionPolicySnapshot(context.runtime, request, policy);
  writeEvidenceNode(context.runtime, reservationNode);
  compareAndSwapEvidenceRef(context.runtime, {
    changeId: status.changeId,
    refName: PLAN_REVIEW_REQUEST_REF,
    expectedNodeId: expectedReservationNodeId,
    nextNodeId: reservationNode.nodeId,
  });
  const reservation = {
    reservationNode,
    planning,
    subject: planning.subject,
    assignment,
    author: recordedAuthor,
    materializationNode,
    targetSnapshotNode,
    manifest,
    request,
    grantAuthorization,
    retry: null,
  };
  authorizePlanReviewReservationMandate(
    cwd,
    mandateBinding,
    reservation,
    assertOwned,
  );
  ensurePlanReviewInvocation(
    context.git.repositoryRoot,
    context.runtime,
    status,
    reservation,
    mandateBinding,
  );
  return reservation;
}

function persistPlanReviewGrantRequirement(
  paths: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  status: ProposeLifecycleStatus,
  requirement: PlanReviewGrantRequirement,
): void {
  const node = createEvidenceNode({
    type: 'plan-review-grant-requirement',
    nodeSchema: 'workflow.plan-review-grant-requirement.v1',
    evaluator: 'workflow-propose.v1',
    policyDigest: PROPOSE_POLICY_DIGEST,
    exactInputDigests: {
      subject: requirement.subject.subjectDigest,
      author: sha256(canonicalJson(requirement.author)),
      grantRequest: sha256(canonicalJson(requirement.grantRequest)),
    },
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: 'workflow.plan-review-grant-requirement-output.v1',
    output: {
      investigationId: status.investigationId,
      changeId: status.changeId,
      ...requirement,
    },
    runtimeMetadata: {},
  });
  writeEvidenceNode(paths, node);
  const current =
    readEvidenceRefs(paths, status.changeId)[
      PLAN_REVIEW_GRANT_REQUIREMENT_REF
    ] ?? null;
  if (current === node.nodeId) {
    return;
  }
  compareAndSwapEvidenceRef(paths, {
    changeId: status.changeId,
    refName: PLAN_REVIEW_GRANT_REQUIREMENT_REF,
    expectedNodeId: current,
    nextNodeId: node.nodeId,
  });
}

function readPlanReviewGrantRequirement(
  paths: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  status: ProposeLifecycleStatus,
): PlanReviewGrantRequirement | null {
  const nodeId = readEvidenceRefs(paths, status.changeId)[
    PLAN_REVIEW_GRANT_REQUIREMENT_REF
  ];
  if (!nodeId) {
    return null;
  }
  const node = readEvidenceNode(paths, nodeId);
  const output = node.output;
  if (
    node.type !== 'plan-review-grant-requirement' ||
    node.nodeSchema !== 'workflow.plan-review-grant-requirement.v1' ||
    node.evaluator !== 'workflow-propose.v1' ||
    node.policyDigest !== PROPOSE_POLICY_DIGEST ||
    !isRecord(output) ||
    !hasExactKeys(output, [
      'investigationId',
      'changeId',
      'subject',
      'author',
      'grantRequest',
    ]) ||
    output.investigationId !== status.investigationId ||
    output.changeId !== status.changeId ||
    !isRecord(output.author)
  ) {
    throw workflowError(
      'PLAN_REVIEW_GRANT_REQUIREMENT_STALE',
      'The durable exact-plan collaboration requirement is malformed.',
      ExitCode.staleState,
    );
  }
  const subject = assertPlanReviewSubject(output.subject);
  const author = output.author as RecordedRoleParticipant;
  const grantRequest =
    output.grantRequest === null
      ? null
      : (output.grantRequest as CollaborationGrantRequest);
  if (
    subject.subjectDigest !== node.exactInputDigests.subject ||
    sha256(canonicalJson(author)) !== node.exactInputDigests.author ||
    sha256(canonicalJson(grantRequest)) !== node.exactInputDigests.grantRequest
  ) {
    throw workflowError(
      'PLAN_REVIEW_GRANT_REQUIREMENT_STALE',
      'The durable exact-plan collaboration requirement no longer matches its evidence node.',
      ExitCode.staleState,
    );
  }
  return { subject, author, grantRequest };
}

function planAuthor(
  paths: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  status: ProposeLifecycleStatus,
): RoleParticipant {
  if (status.state === 'investigation-exempt') {
    return {
      providerId: status.actor.providerId,
      sessionId: `plan-author-${status.investigationId}`,
      principalId: undefined,
      identityAssurance: status.actor.assurance,
      engineSpawned: false,
    };
  }
  const blindRequest = readProviderInvocationRequest(
    paths,
    status.providerInvocationId,
  );
  const authorization = readProposeAuthorization(paths, blindRequest);
  return {
    providerId: authorization.actor.providerId,
    sessionId: `plan-author-${status.investigationId}`,
    principalId: undefined,
    identityAssurance: authorization.actor.assurance,
    engineSpawned: false,
  };
}

function ensurePlanReviewInvocation(
  repositoryRoot: string,
  paths: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  status: ProposeLifecycleStatus,
  reservation: PlanReviewReservation,
  mandateBinding: TaskMandateBinding | undefined,
  prevalidatedSnapshotFiles?: Array<{
    snapshotFile: string;
    content: Buffer;
  }>,
): void {
  if (reservation.retry === null) {
    ensureProviderExecutionPolicySnapshot(
      paths,
      reservation.request,
      loadAiAdapterPolicy(repositoryRoot),
    );
  } else if (reservation.retry.executionPolicySnapshot === null) {
    throw workflowError(
      'PLAN_REVIEW_RETRY_POLICY_SNAPSHOT_REQUIRED',
      'A historical PlanReview retry reservation without a recoverable policy snapshot cannot authorize provider work.',
      ExitCode.guard,
    );
  } else {
    ensureProviderExecutionPolicySnapshotFromSnapshot(
      paths,
      reservation.request,
      reservation.retry.executionPolicySnapshot,
    );
  }
  if (providerInvocationExists(paths, reservation.request.invocationId)) {
    const record = readProviderInvocation(
      paths,
      reservation.request.invocationId,
    );
    const durable = readProviderInvocationRequest(
      paths,
      reservation.request.invocationId,
    );
    if (
      record.investigationId !== status.investigationId ||
      record.changeId !== status.changeId ||
      canonicalJson(record.mandateBinding ?? null) !==
        canonicalJson(mandateBinding ?? null) ||
      record.attempt !== (reservation.retry?.attempt ?? 1) ||
      record.requestDigest !== reservation.request.requestDigest ||
      canonicalJson(durable) !== canonicalJson(reservation.request)
    ) {
      throw workflowError(
        'PLAN_REVIEW_REQUEST_CONFLICT',
        'The durable plan-review request differs from its reservation.',
        ExitCode.conflict,
      );
    }
    return;
  }
  const planReviewSnapshotFiles =
    prevalidatedSnapshotFiles ??
    (reservation.retry === null
      ? reservation.manifest.planningTarget.artifacts.map((artifact) => {
          const target = path.join(repositoryRoot, artifact.path);
          const stats = fs.lstatSync(target, { throwIfNoEntry: false });
          if (
            !stats?.isFile() ||
            stats.isSymbolicLink() ||
            stats.nlink !== 1 ||
            (stats.mode & 0o777) !== 0o644
          ) {
            throw workflowError(
              'PLAN_REVIEW_TARGET_SNAPSHOT_INVALID',
              'Current planning target contains an unsafe artifact.',
              ExitCode.staleState,
            );
          }
          const content = fs.readFileSync(target);
          if (
            content.byteLength !== artifact.byteLength ||
            sha256(content) !== artifact.sha256
          ) {
            throw workflowError(
              'PLAN_REVIEW_TARGET_SNAPSHOT_INVALID',
              'Current planning bytes differ from the reserved target snapshot.',
              ExitCode.staleState,
            );
          }
          return {
            snapshotFile: artifact.snapshotFile,
            content,
          };
        })
      : copyPriorPlanReviewSnapshot(paths, reservation));
  createProviderInvocation(paths, {
    investigationId: status.investigationId,
    changeId: status.changeId,
    ...(mandateBinding ? { mandateBinding } : {}),
    attempt: reservation.retry?.attempt ?? 1,
    manifest: reservation.manifest,
    request: reservation.request,
    planReviewSnapshotFiles,
  });
}

function copyPriorPlanReviewSnapshot(
  paths: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  reservation: PlanReviewReservation,
): Array<{ snapshotFile: string; content: Buffer }> {
  if (reservation.retry === null) {
    throw planReviewRequestStale();
  }
  return readPriorPlanReviewSnapshotFiles(
    paths,
    reservation.manifest,
    reservation.retry.failedInvocation.invocationId,
  );
}

function readPriorPlanReviewSnapshotFiles(
  paths: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  manifest: PlanReviewReservation['manifest'],
  failedInvocationId: string,
): Array<{ snapshotFile: string; content: Buffer }> {
  const snapshot = readPlanReviewSnapshotRuntime(paths, failedInvocationId);
  if (snapshot === null) {
    throw workflowError(
      'PLAN_REVIEW_TARGET_SNAPSHOT_INVALID',
      'Failed PlanReview invocation has no immutable target snapshot.',
      ExitCode.staleState,
    );
  }
  return manifest.planningTarget.artifacts.map((artifact) => {
    const snapshotPath = path.join(snapshot.root, artifact.snapshotFile);
    const stats = fs.lstatSync(snapshotPath, { throwIfNoEntry: false });
    if (
      !stats?.isFile() ||
      stats.isSymbolicLink() ||
      stats.nlink !== 1 ||
      (stats.mode & 0o777) !== 0o600
    ) {
      throw workflowError(
        'PLAN_REVIEW_TARGET_SNAPSHOT_INVALID',
        'Failed PlanReview invocation has an unsafe target snapshot.',
        ExitCode.staleState,
      );
    }
    const content = fs.readFileSync(snapshotPath);
    if (
      content.byteLength !== artifact.byteLength ||
      sha256(content) !== artifact.sha256 ||
      planReviewSnapshotLineCount(content) !== artifact.lineCount
    ) {
      throw workflowError(
        'PLAN_REVIEW_TARGET_SNAPSHOT_INVALID',
        'Failed PlanReview invocation target snapshot no longer matches its manifest.',
        ExitCode.staleState,
      );
    }
    return {
      snapshotFile: artifact.snapshotFile,
      content,
    };
  });
}

function readPlanReviewReservation(
  paths: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  status: ProposeLifecycleStatus,
  expectedSubject?: PlanReviewSubject,
  allowNoncurrentMaterialization = false,
): PlanReviewReservation | null {
  const refs = readEvidenceRefs(paths, status.changeId);
  const nodeId = refs[PLAN_REVIEW_REQUEST_REF];
  if (nodeId === undefined) {
    return null;
  }
  const currentMaterializationNodeId = refs[PLANNING_MATERIALIZATION_REF];
  if (
    !allowNoncurrentMaterialization &&
    currentMaterializationNodeId === undefined
  ) {
    throw planReviewRequestStale();
  }
  let closure: ReturnType<typeof computeInvestigationEvidenceRefsClosure>;
  try {
    closure = computeInvestigationEvidenceRefsClosure(
      paths,
      status.changeId,
      allowNoncurrentMaterialization
        ? { [PLAN_REVIEW_REQUEST_REF]: nodeId }
        : {
            [PLAN_REVIEW_REQUEST_REF]: nodeId,
            [PLANNING_MATERIALIZATION_REF]: currentMaterializationNodeId!,
          },
    );
  } catch {
    throw planReviewRequestStale();
  }
  const closureEntries = closure.entries.filter(
    (entry) => entry.refName === PLAN_REVIEW_REQUEST_REF,
  );
  if (
    closureEntries.length !== 1 ||
    closureEntries[0]?.nodeId !== nodeId ||
    closureEntries[0]?.ownerInvestigationId !== status.investigationId
  ) {
    throw planReviewRequestStale();
  }
  const node = readEvidenceNode(paths, nodeId);
  const output = node.output;
  const retryDecisionShape =
    node.nodeSchema === 'workflow.plan-review-request-reservation.v3';
  const retryShape =
    retryDecisionShape ||
    node.nodeSchema === 'workflow.plan-review-request-reservation.v2';
  if (
    node.type !== 'plan-review-request-reservation' ||
    (!retryShape &&
      node.nodeSchema !== 'workflow.plan-review-request-reservation.v1') ||
    node.evaluator !== 'workflow-propose.v1' ||
    node.policyDigest !== PROPOSE_POLICY_DIGEST ||
    node.outputSchema !==
      (retryDecisionShape
        ? 'workflow.plan-review-request-reservation-output.v3'
        : retryShape
          ? 'workflow.plan-review-request-reservation-output.v2'
          : 'workflow.plan-review-request-reservation-output.v1') ||
    !isRecord(output) ||
    !hasExactKeys(output, [
      'investigationId',
      'changeId',
      'planning',
      'subject',
      'assignment',
      'author',
      'materializationNode',
      'targetSnapshotNode',
      'manifest',
      'request',
      'grantAuthorization',
      ...(retryShape ? ['retry'] : []),
    ]) ||
    !hasExactKeys(node.exactInputDigests, [
      'request',
      'manifest',
      'subject',
      'targetSnapshot',
      ...(retryShape ? ['previousRequest', 'failure'] : []),
      ...(retryDecisionShape
        ? ['executionPolicySnapshot', 'retryDecision']
        : []),
    ]) ||
    !hasExactKeys(node.provenanceParentNodeIds, [
      'authorization',
      ...(retryShape ? ['previousRequest'] : []),
    ]) ||
    !hasExactKeys(node.semanticParentResultDigests, [
      'authorization',
      ...(retryShape ? ['previousRequest'] : []),
    ]) ||
    output.investigationId !== status.investigationId ||
    output.changeId !== status.changeId ||
    !isRecord(output.materializationNode) ||
    !isRecord(output.targetSnapshotNode)
  ) {
    throw workflowError(
      'PLAN_REVIEW_REQUEST_STALE',
      'Durable plan-review request reservation is invalid.',
      ExitCode.staleState,
    );
  }
  const subject = assertPlanReviewSubject(output.subject);
  const planning = output.planning as InvestigationFirstPlanningSubject;
  const request = output.request as ProviderInvocationRequest;
  const manifest = output.manifest as PlanReviewManifest & {
    planningTarget: PlanReviewTargetSnapshot;
  };
  const assignment = output.assignment as ProviderRoleAssignment;
  const author = output.author as RecordedRoleParticipant;
  const materializationNode = assertStoredEvidenceNode(
    output.materializationNode,
    () =>
      workflowError(
        'PLAN_REVIEW_REQUEST_STALE',
        'Durable plan-review materialization evidence is malformed.',
        ExitCode.staleState,
      ),
  );
  const targetSnapshotNode = assertStoredEvidenceNode(
    output.targetSnapshotNode,
    () =>
      workflowError(
        'PLAN_REVIEW_REQUEST_STALE',
        'Durable plan-review target snapshot evidence is malformed.',
        ExitCode.staleState,
      ),
  );
  const storedMaterializationNode = readEvidenceNode(
    paths,
    materializationNode.nodeId,
  );
  const storedTargetSnapshotNode = readEvidenceNode(
    paths,
    targetSnapshotNode.nodeId,
  );
  const targetSnapshot = readPlanReviewTargetSnapshotNode(
    storedTargetSnapshotNode,
  );
  const authorizationNode = readEvidenceNode(
    paths,
    request.authorizationNodeId,
  );
  const grantAuthorization = assertPlanReviewGrantAuthorization(
    output.grantAuthorization,
    author,
    request,
  );
  const retry = retryShape
    ? assertPlanReviewRetryReservation(
        paths,
        node,
        output.retry,
        output,
        request,
      )
    : null;
  if (
    (expectedSubject &&
      canonicalJson(subject) !== canonicalJson(expectedSubject)) ||
    !isRecord(planning) ||
    manifest.planningTarget === undefined ||
    canonicalJson(materializationNode) !==
      canonicalJson(storedMaterializationNode) ||
    canonicalJson(targetSnapshotNode) !==
      canonicalJson(storedTargetSnapshotNode) ||
    canonicalJson(planning.subject) !== canonicalJson(subject) ||
    request.requestDigest !== node.exactInputDigests.request ||
    request.inputManifestDigest !== node.exactInputDigests.manifest ||
    subject.subjectDigest !== node.exactInputDigests.subject ||
    targetSnapshotNode.nodeId !== node.exactInputDigests.targetSnapshot ||
    targetSnapshot.snapshotDigest !== manifest.planningTarget.snapshotDigest ||
    targetSnapshot.materializationNodeId !== materializationNode.nodeId ||
    targetSnapshot.materializationResultDigest !==
      materializationNode.resultDigest ||
    authorizationNode.type !== 'plan-review-authorization' ||
    authorizationNode.nodeSchema !== 'workflow.plan-review-authorization.v1' ||
    authorizationNode.evaluator !== 'workflow-propose.v1' ||
    authorizationNode.policyDigest !== PROPOSE_POLICY_DIGEST ||
    authorizationNode.exactInputDigests.targetSnapshot !==
      targetSnapshotNode.nodeId ||
    authorizationNode.provenanceParentNodeIds.targetSnapshot !==
      targetSnapshotNode.nodeId ||
    authorizationNode.semanticParentResultDigests.targetSnapshot !==
      targetSnapshotNode.resultDigest ||
    authorizationNode.provenanceParentNodeIds.materialization !==
      materializationNode.nodeId ||
    authorizationNode.semanticParentResultDigests.materialization !==
      materializationNode.resultDigest ||
    canonicalJson(request.roleAssignment) !== canonicalJson(assignment) ||
    request.authorizationNodeId !==
      node.provenanceParentNodeIds.authorization ||
    node.semanticParentResultDigests.authorization !==
      authorizationNode.resultDigest ||
    providerInvocationManifestDigest(manifest) !== request.inputManifestDigest
  ) {
    throw workflowError(
      'PLAN_REVIEW_REQUEST_STALE',
      'Durable plan-review request no longer matches the planning subject.',
      ExitCode.staleState,
    );
  }
  return {
    reservationNode: node,
    subject,
    planning,
    assignment,
    author,
    materializationNode,
    targetSnapshotNode,
    manifest,
    request,
    grantAuthorization,
    retry,
  };
}

function assertPlanReviewRetryReservation(
  paths: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  node: EvidenceNode,
  value: unknown,
  output: Record<string, unknown>,
  request: ProviderInvocationRequest,
): NonNullable<PlanReviewReservation['retry']> {
  const retryDecisionShape =
    node.nodeSchema === 'workflow.plan-review-request-reservation.v3';
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'attempt',
      'previousReservationNodeId',
      'failedInvocation',
      ...(retryDecisionShape
        ? ['executionPolicySnapshot', 'retryDecision']
        : []),
    ]) ||
    !Number.isInteger(value.attempt) ||
    (value.attempt as number) < 2 ||
    typeof value.previousReservationNodeId !== 'string' ||
    !DIGEST.test(value.previousReservationNodeId) ||
    !isRecord(value.failedInvocation) ||
    !hasExactKeys(value.failedInvocation, [
      'invocationId',
      'attempt',
      'revision',
      'requestDigest',
      'failureDigest',
    ]) ||
    typeof value.failedInvocation.invocationId !== 'string' ||
    !Number.isInteger(value.failedInvocation.attempt) ||
    (value.failedInvocation.attempt as number) < 1 ||
    !Number.isInteger(value.failedInvocation.revision) ||
    (value.failedInvocation.revision as number) < 0 ||
    typeof value.failedInvocation.requestDigest !== 'string' ||
    !DIGEST.test(value.failedInvocation.requestDigest) ||
    typeof value.failedInvocation.failureDigest !== 'string' ||
    !DIGEST.test(value.failedInvocation.failureDigest)
  ) {
    throw planReviewRequestStale();
  }
  const previousReservationNodeId = value.previousReservationNodeId;
  const failedInvocation =
    value.failedInvocation as PlanReviewRetryEnvelope['failedInvocation'];
  const retryDecision = retryDecisionShape
    ? assertPlanReviewRetryDecisionBinding(value.retryDecision)
    : null;
  let executionPolicySnapshot: ProviderExecutionPolicySnapshotCurrent | null =
    null;
  if (retryDecisionShape) {
    try {
      executionPolicySnapshot = validateProviderExecutionPolicySnapshot(
        request,
        value.executionPolicySnapshot,
      );
    } catch {
      throw planReviewRequestStale();
    }
  }
  const previousNode = readEvidenceNode(paths, previousReservationNodeId);
  const previousOutput = previousNode.output;
  const previousRetryDecisionShape =
    previousNode.nodeSchema === 'workflow.plan-review-request-reservation.v3';
  const previousRetryShape =
    previousRetryDecisionShape ||
    previousNode.nodeSchema === 'workflow.plan-review-request-reservation.v2';
  const previousAttempt =
    previousRetryShape &&
    isRecord(previousOutput) &&
    isRecord(previousOutput.retry) &&
    Number.isInteger(previousOutput.retry.attempt) &&
    (previousOutput.retry.attempt as number) >= 2
      ? (previousOutput.retry.attempt as number)
      : previousRetryShape
        ? 0
        : 1;
  const failed = readProviderInvocation(paths, failedInvocation.invocationId);
  const failedRequest = readProviderInvocationRequest(
    paths,
    failedInvocation.invocationId,
  );
  const {
    invocationId: _failedInvocationId,
    nonce: _failedNonce,
    requestDigest: _failedRequestDigest,
    policyDigest: _failedPolicyDigest,
    limits: _failedLimits,
    ...failedRequestBinding
  } = failedRequest;
  const {
    invocationId: _replacementInvocationId,
    nonce: _replacementNonce,
    requestDigest: _replacementRequestDigest,
    policyDigest: _replacementPolicyDigest,
    limits: _replacementLimits,
    ...replacementRequestBinding
  } = request;
  if (
    previousNode.type !== 'plan-review-request-reservation' ||
    (!previousRetryShape &&
      previousNode.nodeSchema !==
        'workflow.plan-review-request-reservation.v1') ||
    previousNode.evaluator !== 'workflow-propose.v1' ||
    previousNode.policyDigest !== PROPOSE_POLICY_DIGEST ||
    previousNode.outputSchema !==
      (previousRetryDecisionShape
        ? 'workflow.plan-review-request-reservation-output.v3'
        : previousRetryShape
          ? 'workflow.plan-review-request-reservation-output.v2'
          : 'workflow.plan-review-request-reservation-output.v1') ||
    !isRecord(previousOutput) ||
    previousNode.nodeId !== node.exactInputDigests.previousRequest ||
    previousNode.nodeId !== node.provenanceParentNodeIds.previousRequest ||
    previousNode.resultDigest !==
      node.semanticParentResultDigests.previousRequest ||
    failedInvocation.failureDigest !== node.exactInputDigests.failure ||
    (retryDecision !== null &&
      (retryDecision.evidenceDigest !== node.exactInputDigests.retryDecision ||
        retryDecision.failedAttemptId !==
          `attempt-legacy-${failedInvocation.invocationId}`)) ||
    (executionPolicySnapshot !== null &&
      sha256(canonicalJson(executionPolicySnapshot)) !==
        node.exactInputDigests.executionPolicySnapshot) ||
    previousAttempt === 0 ||
    failed.attempt !== previousAttempt ||
    value.attempt !== failed.attempt + 1 ||
    failed.state !== 'failed' ||
    failed.failure === null ||
    failed.failure.kind !== 'retryable' ||
    failed.invocationId !== failedInvocation.invocationId ||
    failed.attempt !== failedInvocation.attempt ||
    failed.revision !== failedInvocation.revision ||
    failed.requestDigest !== failedInvocation.requestDigest ||
    failedRequest.requestDigest !== failedInvocation.requestDigest ||
    sha256(canonicalJson(failed.failure)) !== failedInvocation.failureDigest ||
    canonicalJson(previousOutput.request) !== canonicalJson(failedRequest) ||
    canonicalJson(previousOutput.subject) !== canonicalJson(output.subject) ||
    canonicalJson(previousOutput.planning) !== canonicalJson(output.planning) ||
    canonicalJson(previousOutput.assignment) !==
      canonicalJson(output.assignment) ||
    canonicalJson(previousOutput.author) !== canonicalJson(output.author) ||
    canonicalJson(previousOutput.materializationNode) !==
      canonicalJson(output.materializationNode) ||
    canonicalJson(previousOutput.targetSnapshotNode) !==
      canonicalJson(output.targetSnapshotNode) ||
    canonicalJson(previousOutput.manifest) !== canonicalJson(output.manifest) ||
    canonicalJson(previousOutput.grantAuthorization) !==
      canonicalJson(output.grantAuthorization) ||
    request.requestDigest === failedRequest.requestDigest ||
    request.invocationId === failedRequest.invocationId ||
    request.nonce === failedRequest.nonce ||
    canonicalJson(replacementRequestBinding) !==
      canonicalJson(failedRequestBinding)
  ) {
    throw planReviewRequestStale();
  }
  return {
    attempt: value.attempt as number,
    previousReservationNodeId,
    failedInvocation,
    retryDecision,
    executionPolicySnapshot,
  };
}

function assertPlanReviewRetryDecisionBinding(
  value: unknown,
): ProviderRetryDecisionBinding {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'evaluatedAt',
      'evidenceDigest',
      'executionJobId',
      'executionRevision',
      'failedAttemptId',
      'kind',
      'schemaVersion',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'provider-retry-decision-binding' ||
    typeof value.executionJobId !== 'string' ||
    !/^[a-z0-9][a-z0-9._:-]{0,255}$/.test(value.executionJobId) ||
    !Number.isSafeInteger(value.executionRevision) ||
    (value.executionRevision as number) < 0 ||
    typeof value.failedAttemptId !== 'string' ||
    !/^[a-z0-9][a-z0-9._:-]{0,255}$/.test(value.failedAttemptId) ||
    typeof value.evidenceDigest !== 'string' ||
    !DIGEST.test(value.evidenceDigest) ||
    typeof value.evaluatedAt !== 'string' ||
    Number.isNaN(Date.parse(value.evaluatedAt))
  ) {
    throw planReviewRequestStale();
  }
  return value as ProviderRetryDecisionBinding;
}

function planReviewRequestStale() {
  return workflowError(
    'PLAN_REVIEW_REQUEST_STALE',
    'Durable plan-review request reservation is invalid.',
    ExitCode.staleState,
  );
}

function assertPlanReviewGrantAuthorization(
  value: unknown,
  author: RecordedRoleParticipant,
  request: ProviderInvocationRequest,
): ProposeGrantAuthorization | null {
  if (!('grantId' in request.roleAssignment)) {
    if (
      value !== null ||
      author.providerId === null ||
      request.providerId === author.providerId ||
      request.roleAssignment.achievedIndependence !== 'provider-independent'
    ) {
      throw workflowError(
        'PLAN_REVIEW_REQUEST_STALE',
        'Ordinary plan-review authorization is not provider-independent.',
        ExitCode.staleState,
      );
    }
    return null;
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['grantId', 'transitionDigest', 'expectedBinding']) ||
    value.grantId !== request.roleAssignment.grantId ||
    typeof value.transitionDigest !== 'string' ||
    !DIGEST.test(value.transitionDigest) ||
    !isRecord(value.expectedBinding)
  ) {
    throw workflowError(
      'PLAN_REVIEW_REQUEST_STALE',
      'Granted plan-review authorization is malformed.',
      ExitCode.staleState,
    );
  }
  const expectedBinding =
    value.expectedBinding as CollaborationGrantExpectedBinding;
  if (
    author.providerId === null ||
    request.providerId !== author.providerId ||
    request.roleAssignment.providerId !== author.providerId ||
    request.roleAssignment.achievedIndependence !== 'session-independent' ||
    expectedBinding.collaborationPolicyDigest !==
      COLLABORATION_GRANT_POLICY_DIGEST ||
    expectedBinding.baselineCommit !== request.baseCommit ||
    expectedBinding.baselineTree !== request.baseTree ||
    expectedBinding.targetDigest !== request.targetDigest ||
    expectedBinding.lifecyclePhase !== 'plan-review' ||
    canonicalJson(expectedBinding.rolePair) !==
      canonicalJson({
        authorRole: 'plan-author',
        conflictingRole: 'plan-reviewer',
      }) ||
    canonicalJson(expectedBinding.availableActor) !==
      canonicalJson({
        kind: 'provider',
        providerId: author.providerId,
        assurance: author.identityAssurance,
      }) ||
    expectedBinding.degradedForm !== 'same-provider-fresh-session' ||
    expectedBinding.reason !== PLAN_REVIEW_GRANT_REASON ||
    collaborationTransitionDigest(expectedBinding) !== value.transitionDigest
  ) {
    throw workflowError(
      'PLAN_REVIEW_REQUEST_STALE',
      'Granted plan-review authorization no longer matches the exact subject.',
      ExitCode.staleState,
    );
  }
  return {
    grantId: String(value.grantId),
    transitionDigest: value.transitionDigest,
    expectedBinding,
  };
}

function readPlanningMaterializationReceipt(
  paths: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  status: InvestigationStatus,
  sealNode: EvidenceNode,
): Record<string, string> | null {
  const nodeId = readEvidenceRefs(paths, status.changeId)[
    PLANNING_MATERIALIZATION_REF
  ];
  if (nodeId === undefined) {
    return null;
  }
  const node = readEvidenceNode(paths, nodeId);
  const output = node.output;
  const semanticReceipt =
    node.nodeSchema === 'workflow.propose-planning-materialization.v2' &&
    node.outputSchema === 'workflow.propose-planning-materialization-output.v2';
  const legacyReceipt =
    node.nodeSchema === 'workflow.propose-planning-materialization.v1' &&
    node.outputSchema === 'workflow.propose-planning-materialization-output.v1';
  if (
    node.type !== 'propose-planning-materialization' ||
    (!semanticReceipt && !legacyReceipt) ||
    node.evaluator !== 'workflow-propose.v1' ||
    node.policyDigest !== PROPOSE_POLICY_DIGEST ||
    !isRecord(output) ||
    !hasExactKeys(output, [
      'investigationId',
      'changeId',
      semanticReceipt ? 'semanticRevision' : 'revision',
      'baseline',
      'artifacts',
      'sealNodeId',
      'sealResultDigest',
    ]) ||
    output.investigationId !== status.investigationId ||
    output.changeId !== status.changeId ||
    (semanticReceipt
      ? output.semanticRevision !== status.semanticRevision
      : output.revision !== status.revision) ||
    canonicalJson(output.baseline) !== canonicalJson(status.baseline) ||
    output.sealNodeId !== sealNode.nodeId ||
    output.sealResultDigest !== sealNode.resultDigest ||
    !isDigestRecord(output.artifacts) ||
    node.exactInputDigests.artifacts !==
      sha256(canonicalJson(output.artifacts)) ||
    node.exactInputDigests.baseline !==
      sha256(canonicalJson(status.baseline)) ||
    node.exactInputDigests.seal !== sealNode.nodeId ||
    node.provenanceParentNodeIds.seal !== sealNode.nodeId ||
    node.semanticParentResultDigests.seal !== sealNode.resultDigest
  ) {
    throw workflowError(
      'PLANNING_MATERIALIZATION_STALE',
      'Durable planning materialization evidence is invalid or stale.',
      ExitCode.staleState,
    );
  }
  return output.artifacts as Record<string, string>;
}

function readExemptionPlanningMaterializationReceipt(
  paths: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  session: ProposeExemptionSession,
): Record<string, string> | null {
  const nodeId = readEvidenceRefs(paths, session.changeId)[
    PLANNING_MATERIALIZATION_REF
  ];
  if (nodeId === undefined) {
    return null;
  }
  const node = readEvidenceNode(paths, nodeId);
  const output = node.output;
  if (
    node.type !== 'propose-exemption-planning-materialization' ||
    node.nodeSchema !==
      'workflow.propose-exemption-planning-materialization.v1' ||
    node.evaluator !== 'workflow-propose.v1' ||
    node.policyDigest !== PROPOSE_POLICY_DIGEST ||
    node.outputSchema !==
      'workflow.propose-exemption-planning-materialization-output.v1' ||
    !isRecord(output) ||
    !hasExactKeys(output, [
      'investigationId',
      'changeId',
      'revision',
      'baseline',
      'artifacts',
      'applicabilityNodeId',
      'applicabilityResultDigest',
    ]) ||
    output.investigationId !== session.investigationId ||
    output.changeId !== session.changeId ||
    output.revision !== session.revision ||
    canonicalJson(output.baseline) !== canonicalJson(session.baseline) ||
    output.applicabilityNodeId !== session.applicabilityNode.nodeId ||
    output.applicabilityResultDigest !==
      session.applicabilityNode.resultDigest ||
    !isDigestRecord(output.artifacts) ||
    node.exactInputDigests.artifacts !==
      sha256(canonicalJson(output.artifacts)) ||
    node.exactInputDigests.baseline !==
      sha256(canonicalJson(session.baseline)) ||
    node.exactInputDigests.applicability !== session.applicabilityNode.nodeId ||
    node.provenanceParentNodeIds.applicability !==
      session.applicabilityNode.nodeId ||
    node.semanticParentResultDigests.applicability !==
      session.applicabilityNode.resultDigest
  ) {
    throw workflowError(
      'PLANNING_MATERIALIZATION_STALE',
      'Durable exemption planning materialization evidence is invalid or stale.',
      ExitCode.staleState,
    );
  }
  return output.artifacts as Record<string, string>;
}

function readMaterializedPlanningArtifacts(
  cwd: string,
  status: InvestigationStatus,
  rebuilt: RebuiltInvestigation,
  scaffold: {
    changeDirectory: string;
    investigationBytes: string;
  },
): Record<string, string> | null {
  const context = loadInvestigationRuntimeContext(cwd);
  const receipt = readPlanningMaterializationReceipt(
    context.runtime,
    status,
    createInvestigationSealNode(rebuilt),
  );
  if (receipt === null) {
    return null;
  }
  const required = [
    '.openspec.yaml',
    'investigation.json',
    'proposal.md',
    'design.md',
    'tasks.md',
    'guard.json',
    'execution.json',
  ];
  if (
    required.some(
      (relativePath) =>
        !fs
          .statSync(path.join(scaffold.changeDirectory, relativePath), {
            throwIfNoEntry: false,
          })
          ?.isFile(),
    )
  ) {
    throw planningMaterializationStale(
      'A required planning artifact is missing from the durable materialization.',
    );
  }
  const hasPlanReview = fs.existsSync(
    path.join(scaffold.changeDirectory, 'plan-review.json'),
  );
  const adapter = createOpenSpecAdapter(context.git.repositoryRoot);
  const openspecStatus = adapter.status(status.changeId, 'expense-app-v2');
  if (
    (hasPlanReview && !openspecStatus.isComplete) ||
    (!hasPlanReview && openspecStatus.isComplete) ||
    openspecStatus.artifacts.find(({ id }) => id === 'plan-review')?.status !==
      (hasPlanReview ? 'done' : 'ready')
  ) {
    throw planningMaterializationStale(
      'OpenSpec no longer observes the receipt-bound review-pending graph.',
    );
  }
  const entries = new Map<string, string>();
  for (const relativePath of required) {
    entries.set(
      relativePath,
      fs.readFileSync(
        path.join(scaffold.changeDirectory, relativePath),
        'utf8',
      ),
    );
  }
  for (const specPath of listSpecFiles(scaffold.changeDirectory)) {
    entries.set(
      specPath,
      fs.readFileSync(path.join(scaffold.changeDirectory, specPath), 'utf8'),
    );
  }
  assertPlanningTargetsCompatible(
    scaffold.changeDirectory,
    entries,
    false,
    false,
    true,
  );
  const observed = artifactDigests(entries);
  if (canonicalJson(observed) !== canonicalJson(receipt)) {
    throw planningMaterializationStale(
      'Current planning bytes differ from durable materialization evidence.',
    );
  }
  return observed;
}

function readMaterializedExemptionPlanningArtifacts(
  cwd: string,
  session: ProposeExemptionSession,
  changeDirectory: string,
): Record<string, string> {
  const context = loadInvestigationRuntimeContext(cwd);
  const receipt = readExemptionPlanningMaterializationReceipt(
    context.runtime,
    session,
  );
  if (receipt === null) {
    throw planningMaterializationStale(
      'Structured exemption planning has no durable materialization receipt.',
    );
  }
  const required = [
    '.openspec.yaml',
    'investigation.json',
    'proposal.md',
    'design.md',
    'tasks.md',
    'guard.json',
    'execution.json',
  ];
  if (
    required.some(
      (relativePath) =>
        !fs
          .statSync(path.join(changeDirectory, relativePath), {
            throwIfNoEntry: false,
          })
          ?.isFile(),
    )
  ) {
    throw planningMaterializationStale(
      'A required exemption planning artifact is missing from the durable materialization.',
    );
  }
  const hasPlanReview = fs.existsSync(
    path.join(changeDirectory, 'plan-review.json'),
  );
  const adapter = createOpenSpecAdapter(context.git.repositoryRoot);
  const openspecStatus = adapter.status(session.changeId, 'expense-app-v2');
  if (
    (hasPlanReview && !openspecStatus.isComplete) ||
    (!hasPlanReview && openspecStatus.isComplete) ||
    openspecStatus.artifacts.find(({ id }) => id === 'plan-review')?.status !==
      (hasPlanReview ? 'done' : 'ready')
  ) {
    throw planningMaterializationStale(
      'OpenSpec no longer observes the receipt-bound exemption review graph.',
    );
  }
  const entries = new Map<string, string>();
  for (const relativePath of required) {
    entries.set(
      relativePath,
      fs.readFileSync(path.join(changeDirectory, relativePath), 'utf8'),
    );
  }
  for (const specPath of listSpecFiles(changeDirectory)) {
    entries.set(
      specPath,
      fs.readFileSync(path.join(changeDirectory, specPath), 'utf8'),
    );
  }
  assertPlanningTargetsCompatible(changeDirectory, entries, false, false, true);
  const observed = artifactDigests(entries);
  if (canonicalJson(observed) !== canonicalJson(receipt)) {
    throw planningMaterializationStale(
      'Current exemption planning bytes differ from durable materialization evidence.',
    );
  }
  return observed;
}

function assertPlanningTargetsCompatible(
  changeDirectory: string,
  entries: Map<string, string>,
  scaffoldOnly: boolean,
  allowAuthoredExisting = false,
  allowManagedPlanReview = false,
  legacyMigration: LegacyPlanMigrationSubject | null = null,
): void {
  const allowedExisting = new Set(entries.keys());
  const existing = listChangeFiles(changeDirectory);
  for (const relativePath of existing) {
    if (!allowedExisting.has(relativePath)) {
      if (scaffoldOnly) {
        if (relativePath === 'plan-review.json' && allowManagedPlanReview) {
          continue;
        }
        if (
          allowAuthoredExisting &&
          ([
            'proposal.md',
            'design.md',
            'tasks.md',
            'guard.json',
            'execution.json',
          ].includes(relativePath) ||
            relativePath.startsWith('specs/'))
        ) {
          continue;
        }
        throw workflowError(
          'UNMANAGED_PLANNING_CONFLICT',
          'A new investigation-first change already contains unmanaged planning bytes.',
          ExitCode.conflict,
          { details: { relativePath } },
        );
      }
      if (relativePath === 'plan-review.json') {
        if (allowManagedPlanReview) {
          continue;
        }
        throw workflowError(
          'PLAN_REVIEW_ALREADY_PRESENT',
          'Task 5.2 cannot adopt or replace a plan review.',
          ExitCode.conflict,
        );
      }
      if (!relativePath.startsWith('specs/')) {
        throw workflowError(
          'UNMANAGED_PLANNING_CONFLICT',
          'Planning materialization found an unexpected existing path.',
          ExitCode.conflict,
        );
      }
    }
  }
  for (const [relativePath, expected] of entries) {
    const target = path.join(changeDirectory, relativePath);
    const stats = fs.lstatSync(target, { throwIfNoEntry: false });
    if (!stats) {
      continue;
    }
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw workflowError(
        'UNMANAGED_PLANNING_CONFLICT',
        'Existing planning bytes differ from the managed projection.',
        ExitCode.conflict,
      );
    }
    const existing = fs.readFileSync(target, 'utf8');
    if (
      existing !== expected &&
      !(
        legacyMigration !== null &&
        isReplaceableLegacyArtifact(legacyMigration, relativePath, existing)
      )
    ) {
      throw workflowError(
        'UNMANAGED_PLANNING_CONFLICT',
        'Existing planning bytes differ from the managed projection.',
        ExitCode.conflict,
      );
    }
  }
}

/**
 * Create the entries that do not exist yet, and — only under an authorized
 * legacy migration — regenerate the exact governed legacy bytes the migration
 * replaces. Every other existing byte is left untouched.
 */
function writeManagedEntries(
  changeDirectory: string,
  entries: Map<string, string>,
  legacyMigration: LegacyPlanMigrationSubject | null = null,
): void {
  for (const [relativePath, content] of entries) {
    const target = path.join(changeDirectory, relativePath);
    if (!fs.existsSync(target)) {
      replaceTextAtomic(target, content, {
        allowCreate: true,
        defaultMode: 0o644,
      });
      continue;
    }
    if (
      legacyMigration !== null &&
      isReplaceableLegacyArtifact(
        legacyMigration,
        relativePath,
        fs.readFileSync(target, 'utf8'),
      )
    ) {
      replaceTextAtomic(target, content, { defaultMode: 0o644 });
    }
  }
}

function inputSchemaForStatus(
  cwd: string,
  status: InvestigationStatus,
): Record<string, unknown> | null {
  if (status.checkpoint !== null) {
    return {
      schemaVersion: 1,
      kind: 'investigation-checkpoint',
      checkpointKind: status.checkpoint.kind,
      checkpointId: status.checkpoint.checkpointId,
      binding: {
        investigationId: status.investigationId,
        changeId: status.changeId,
        expectedRevision: status.revision,
        baseline: status.baseline,
        intentDigest: status.intentDigest,
        blindManifestDigest: status.blindManifestDigest,
      },
    };
  }
  if (
    status.nextAction === 'wait-for-provider' ||
    status.nextAction === 'resume-provider-result'
  ) {
    return {
      schemaVersion: 1,
      kind: 'provider-progress',
      binding: createProviderProgressEnvelope(status),
    };
  }
  if (
    status.nextAction === 'retry-provider' &&
    status.provider.state === 'failed' &&
    status.provider.failure?.kind === 'retryable'
  ) {
    const context = loadInvestigationRuntimeContext(cwd);
    const request = readProviderInvocationRequest(
      context.runtime,
      status.providerInvocationId,
    );
    return {
      schemaVersion: 1,
      kind: 'provider-retry',
      binding: {
        investigationId: status.investigationId,
        changeId: status.changeId,
        expectedRevision: status.revision,
        baseline: status.baseline,
        intentDigest: status.intentDigest,
        blindManifestDigest: status.blindManifestDigest,
        failedInvocation: {
          invocationId: status.providerInvocationId,
          attempt: status.provider.attempt,
          revision: status.provider.revision,
          requestDigest: request.requestDigest,
          failureDigest: sha256(canonicalJson(status.provider.failure)),
        },
      },
      requiredAcknowledgement: {
        acknowledgeProviderCost: true,
      },
    };
  }
  return null;
}

function planningContributionSchema(
  status: InvestigationStatus,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: 'planning-contribution',
    binding: {
      investigationId: status.investigationId,
      changeId: status.changeId,
      expectedRevision: status.revision,
      baseline: status.baseline,
      intentDigest: status.intentDigest,
      blindManifestDigest: status.blindManifestDigest,
    },
    payloadFields: [
      'proposal',
      'design',
      'specs',
      'tasks',
      'guard',
      'executionTasks',
    ],
    engineOwnedFieldsRejected: ['investigation', 'planReview'],
  };
}

function exemptionPlanningContributionSchema(
  status: ProposeExemptionSession,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: 'exemption-planning-contribution',
    binding: {
      investigationId: status.investigationId,
      changeId: status.changeId,
      expectedRevision: status.revision,
      baseline: status.baseline,
      intentDigest: status.intentDigest,
      applicabilityDigest: status.applicability.applicabilityDigest,
    },
    payloadFields: [
      'proposal',
      'design',
      'specs',
      'tasks',
      'guard',
      'executionTasks',
    ],
    engineOwnedFieldsRejected: ['investigation', 'planReview'],
  };
}

function assertProposeInput(value: unknown): ProposeInput {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw proposeInputInvalid();
  }
  if (value.kind === 'planning-contribution') {
    return assertPlanningContributionEnvelope(value);
  }
  if (value.kind === 'exemption-planning-contribution') {
    return assertExemptionPlanningContributionEnvelope(value);
  }
  if (value.kind === 'provider-progress') {
    return assertProviderProgressEnvelope(value);
  }
  if (value.kind === 'provider-retry') {
    return assertProviderRetryEnvelope(value);
  }
  if (value.kind === 'plan-review-retry') {
    return assertPlanReviewRetryEnvelope(value);
  }
  if (value.kind === 'plan-review-progress') {
    return assertPlanReviewProgressEnvelope(value);
  }
  if (value.kind === 'plan-review-dispositions') {
    return assertPlanReviewDispositionsEnvelope(value);
  }
  return assertInvestigationCheckpointEnvelope(value);
}

function assertExemptionPlanningContributionEnvelope(
  value: unknown,
): ExemptionPlanningContributionEnvelope {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'investigationId',
      'changeId',
      'expectedRevision',
      'baseline',
      'intentDigest',
      'applicabilityDigest',
      'payload',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'exemption-planning-contribution' ||
    typeof value.investigationId !== 'string' ||
    typeof value.changeId !== 'string' ||
    value.expectedRevision !== 0 ||
    !isBaseline(value.baseline) ||
    typeof value.intentDigest !== 'string' ||
    !DIGEST.test(value.intentDigest) ||
    typeof value.applicabilityDigest !== 'string' ||
    !DIGEST.test(value.applicabilityDigest)
  ) {
    throw proposeInputInvalid();
  }
  return {
    schemaVersion: 1,
    kind: 'exemption-planning-contribution',
    investigationId: value.investigationId,
    changeId: assertChangeId(value.changeId),
    expectedRevision: 0,
    baseline: value.baseline,
    intentDigest: value.intentDigest,
    applicabilityDigest: value.applicabilityDigest,
    payload: assertPlanningPayload(value.payload),
  };
}

function assertPlanReviewProgressEnvelope(
  value: unknown,
): PlanReviewProgressEnvelope {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'investigationId',
      'changeId',
      'subjectDigest',
      'invocationId',
      'requestDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'plan-review-progress' ||
    typeof value.investigationId !== 'string' ||
    typeof value.changeId !== 'string' ||
    typeof value.subjectDigest !== 'string' ||
    !DIGEST.test(value.subjectDigest) ||
    typeof value.invocationId !== 'string' ||
    typeof value.requestDigest !== 'string' ||
    !DIGEST.test(value.requestDigest)
  ) {
    throw proposeInputInvalid();
  }
  return value as PlanReviewProgressEnvelope;
}

function assertPlanReviewDispositionsEnvelope(
  value: unknown,
): PlanReviewDispositionsEnvelope {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'investigationId',
      'changeId',
      'subjectDigest',
      'reviewNodeId',
      'reviewResultDigest',
      'dispositions',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'plan-review-dispositions' ||
    typeof value.investigationId !== 'string' ||
    typeof value.changeId !== 'string' ||
    typeof value.subjectDigest !== 'string' ||
    !DIGEST.test(value.subjectDigest) ||
    typeof value.reviewNodeId !== 'string' ||
    !DIGEST.test(value.reviewNodeId) ||
    typeof value.reviewResultDigest !== 'string' ||
    !DIGEST.test(value.reviewResultDigest) ||
    !Array.isArray(value.dispositions)
  ) {
    throw proposeInputInvalid();
  }
  return value as PlanReviewDispositionsEnvelope;
}

function assertPlanningContributionEnvelope(
  value: unknown,
): PlanningContributionEnvelope {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'investigationId',
      'changeId',
      'expectedRevision',
      'baseline',
      'intentDigest',
      'blindManifestDigest',
      'payload',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'planning-contribution' ||
    typeof value.investigationId !== 'string' ||
    typeof value.changeId !== 'string' ||
    !Number.isInteger(value.expectedRevision) ||
    (value.expectedRevision as number) < 0 ||
    !isBaseline(value.baseline) ||
    typeof value.intentDigest !== 'string' ||
    !DIGEST.test(value.intentDigest) ||
    typeof value.blindManifestDigest !== 'string' ||
    !DIGEST.test(value.blindManifestDigest)
  ) {
    throw proposeInputInvalid();
  }
  return {
    schemaVersion: 1,
    kind: 'planning-contribution',
    investigationId: value.investigationId,
    changeId: assertChangeId(value.changeId),
    expectedRevision: value.expectedRevision as number,
    baseline: value.baseline,
    intentDigest: value.intentDigest,
    blindManifestDigest: value.blindManifestDigest,
    payload: assertPlanningPayload(value.payload),
  };
}

function assertProviderProgressEnvelope(
  value: unknown,
): ProviderProgressEnvelope {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'investigationId',
      'changeId',
      'expectedRevision',
      'baseline',
      'intentDigest',
      'blindManifestDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'provider-progress' ||
    typeof value.investigationId !== 'string' ||
    typeof value.changeId !== 'string' ||
    !Number.isInteger(value.expectedRevision) ||
    (value.expectedRevision as number) < 0 ||
    !isBaseline(value.baseline) ||
    typeof value.intentDigest !== 'string' ||
    !DIGEST.test(value.intentDigest) ||
    typeof value.blindManifestDigest !== 'string' ||
    !DIGEST.test(value.blindManifestDigest)
  ) {
    throw proposeInputInvalid();
  }
  return value as ProviderProgressEnvelope;
}

function assertProviderRetryEnvelope(value: unknown): ProviderRetryEnvelope {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'investigationId',
      'changeId',
      'expectedRevision',
      'baseline',
      'intentDigest',
      'blindManifestDigest',
      'failedInvocation',
      'acknowledgeProviderCost',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'provider-retry' ||
    typeof value.investigationId !== 'string' ||
    typeof value.changeId !== 'string' ||
    !Number.isInteger(value.expectedRevision) ||
    (value.expectedRevision as number) < 0 ||
    !isBaseline(value.baseline) ||
    typeof value.intentDigest !== 'string' ||
    !DIGEST.test(value.intentDigest) ||
    typeof value.blindManifestDigest !== 'string' ||
    !DIGEST.test(value.blindManifestDigest) ||
    !isRecord(value.failedInvocation) ||
    !hasExactKeys(value.failedInvocation, [
      'invocationId',
      'attempt',
      'revision',
      'requestDigest',
      'failureDigest',
    ]) ||
    typeof value.failedInvocation.invocationId !== 'string' ||
    !Number.isInteger(value.failedInvocation.attempt) ||
    (value.failedInvocation.attempt as number) < 1 ||
    !Number.isInteger(value.failedInvocation.revision) ||
    (value.failedInvocation.revision as number) < 0 ||
    typeof value.failedInvocation.requestDigest !== 'string' ||
    !DIGEST.test(value.failedInvocation.requestDigest) ||
    typeof value.failedInvocation.failureDigest !== 'string' ||
    !DIGEST.test(value.failedInvocation.failureDigest) ||
    value.acknowledgeProviderCost !== true
  ) {
    throw proposeInputInvalid();
  }
  return value as ProviderRetryEnvelope;
}

function assertPlanReviewRetryEnvelope(
  value: unknown,
): PlanReviewRetryEnvelope {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'investigationId',
      'changeId',
      'expectedRevision',
      'baseline',
      'subjectDigest',
      'planningGenerationId',
      'expectedReservationNodeId',
      'failedInvocation',
      'acknowledgeProviderCost',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'plan-review-retry' ||
    typeof value.investigationId !== 'string' ||
    typeof value.changeId !== 'string' ||
    !Number.isInteger(value.expectedRevision) ||
    (value.expectedRevision as number) < 0 ||
    !isBaseline(value.baseline) ||
    typeof value.subjectDigest !== 'string' ||
    !DIGEST.test(value.subjectDigest) ||
    typeof value.planningGenerationId !== 'string' ||
    !DIGEST.test(value.planningGenerationId) ||
    typeof value.expectedReservationNodeId !== 'string' ||
    !DIGEST.test(value.expectedReservationNodeId) ||
    !isRecord(value.failedInvocation) ||
    !hasExactKeys(value.failedInvocation, [
      'invocationId',
      'attempt',
      'revision',
      'requestDigest',
      'failureDigest',
    ]) ||
    typeof value.failedInvocation.invocationId !== 'string' ||
    !Number.isInteger(value.failedInvocation.attempt) ||
    (value.failedInvocation.attempt as number) < 1 ||
    !Number.isInteger(value.failedInvocation.revision) ||
    (value.failedInvocation.revision as number) < 0 ||
    typeof value.failedInvocation.requestDigest !== 'string' ||
    !DIGEST.test(value.failedInvocation.requestDigest) ||
    typeof value.failedInvocation.failureDigest !== 'string' ||
    !DIGEST.test(value.failedInvocation.failureDigest) ||
    value.acknowledgeProviderCost !== true
  ) {
    throw proposeInputInvalid();
  }
  return value as PlanReviewRetryEnvelope;
}

function assertPlanningBinding(
  status: InvestigationStatus,
  input: PlanningContributionEnvelope,
): void {
  if (
    input.investigationId !== status.investigationId ||
    input.changeId !== status.changeId ||
    input.expectedRevision !== status.revision ||
    canonicalJson(input.baseline) !== canonicalJson(status.baseline) ||
    input.intentDigest !== status.intentDigest ||
    input.blindManifestDigest !== status.blindManifestDigest
  ) {
    throw workflowError(
      'PROPOSE_INPUT_STALE',
      'Planning contribution is not bound to the current sealed investigation.',
      ExitCode.staleState,
    );
  }
}

function assertProgressBinding(
  status: InvestigationStatus,
  input: ProviderProgressEnvelope,
): void {
  if (
    input.investigationId !== status.investigationId ||
    input.changeId !== status.changeId ||
    canonicalJson(input.baseline) !== canonicalJson(status.baseline) ||
    input.intentDigest !== status.intentDigest ||
    input.blindManifestDigest !== status.blindManifestDigest
  ) {
    throw workflowError(
      'PROPOSE_INPUT_STALE',
      'Provider progress input is not bound to the current investigation.',
      ExitCode.staleState,
    );
  }
}

function isExactPublishedProviderProgressReplay(
  cwd: string,
  status: InvestigationStatus,
): boolean {
  const context = loadInvestigationRuntimeContext(cwd);
  const session = readInvestigationSession(
    context.runtime,
    status.investigationId,
  );
  const published = session.milestones.blindResult;
  return (
    session.revision === status.revision &&
    session.currentBlindInvocationId === status.providerInvocationId &&
    published !== null &&
    published.invocationId === status.providerInvocationId &&
    published.requestDigest === session.blindRequestDigest &&
    published.outputDigest === status.provider.resultDigest &&
    status.provider.state === 'succeeded'
  );
}

function assertPlanningPayload(value: unknown): PlanningContributionPayload {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'proposal',
      'design',
      'specs',
      'tasks',
      'guard',
      'executionTasks',
    ]) ||
    typeof value.proposal !== 'string' ||
    typeof value.design !== 'string' ||
    !Array.isArray(value.specs) ||
    typeof value.tasks !== 'string' ||
    !isRecord(value.guard) ||
    !isRecord(value.executionTasks)
  ) {
    throw planningContributionInvalid();
  }
  return {
    proposal: value.proposal,
    design: value.design,
    specs: assertSpecContributions(value.specs),
    tasks: value.tasks,
    guard: value.guard as GuardContract,
    executionTasks: value.executionTasks as ExecutionArtifact['tasks'],
  };
}

function assertSpecContributions(
  value: unknown,
): Array<{ path: string; content: string }> {
  if (!Array.isArray(value) || value.length === 0) {
    throw planningContributionInvalid(
      'At least one delta specification is required.',
    );
  }
  const seen = new Set<string>();
  return value
    .map((entry) => {
      if (
        !isRecord(entry) ||
        !hasExactKeys(entry, ['path', 'content']) ||
        typeof entry.path !== 'string' ||
        typeof entry.content !== 'string' ||
        !/^specs\/[a-z0-9]+(?:-[a-z0-9]+)*\/spec\.md$/.test(entry.path) ||
        seen.has(entry.path)
      ) {
        throw planningContributionInvalid(
          'Delta specification paths or bytes are invalid.',
        );
      }
      seen.add(entry.path);
      return {
        path: entry.path,
        content: assertAuthoredMarkdown(entry.content, entry.path),
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function assertAuthoredMarkdown(value: string, label: string): string {
  if (
    value.trim().length === 0 ||
    !value.endsWith('\n') ||
    value.includes('\r') ||
    Buffer.byteLength(value, 'utf8') > MAX_CALLER_JSON_BYTES
  ) {
    throw planningContributionInvalid(
      `Authored ${label} bytes are not valid LF-terminated Markdown.`,
    );
  }
  return value;
}

function assertGuardContribution(
  value: unknown,
  changeId: string,
  taskIds: string[],
  knownChecks: string[],
): GuardContract {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['schemaVersion', 'changeId', 'tasks']) ||
    value.schemaVersion !== 1 ||
    value.changeId !== changeId ||
    !isRecord(value.tasks)
  ) {
    throw planningContributionInvalid('Guard contribution is malformed.');
  }
  const result: GuardContract = {
    schemaVersion: 1,
    changeId,
    tasks: {},
  };
  if (
    canonicalJson(Object.keys(value.tasks).sort()) !==
    canonicalJson([...taskIds].sort())
  ) {
    throw planningContributionInvalid(
      'Guard tasks do not match authored tasks.',
    );
  }
  for (const taskId of taskIds) {
    const policy = value.tasks[taskId];
    if (
      !isRecord(policy) ||
      !hasExactKeys(policy, ['allowedPaths', 'requiredChecks']) ||
      !isStringArray(policy.allowedPaths) ||
      policy.allowedPaths.length === 0 ||
      !isStringArray(policy.requiredChecks) ||
      policy.requiredChecks.length === 0 ||
      new Set(policy.allowedPaths).size !== policy.allowedPaths.length ||
      new Set(policy.requiredChecks).size !== policy.requiredChecks.length ||
      policy.requiredChecks.some((checkId) => !knownChecks.includes(checkId))
    ) {
      throw planningContributionInvalid(
        `Guard policy for task ${taskId} is malformed.`,
      );
    }
    for (const allowedPath of policy.allowedPaths) {
      normalizePolicyPath(allowedPath);
    }
    result.tasks[taskId] = {
      allowedPaths: [...policy.allowedPaths],
      requiredChecks: [...policy.requiredChecks],
    };
  }
  return result;
}

function assertNormalizedIntent(value: unknown): NormalizedChangeIntent {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'summary',
      'explicitPaths',
      'explicitSymbols',
      'explicitConfigKeys',
      'renamePairs',
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.summary !== 'string' ||
    value.summary.trim().length === 0 ||
    !isStringArray(value.explicitPaths) ||
    !isStringArray(value.explicitSymbols) ||
    !isStringArray(value.explicitConfigKeys) ||
    !Array.isArray(value.renamePairs)
  ) {
    throw workflowError(
      'PROPOSE_INTENT_INVALID',
      'Propose intent does not match normalized intent schema version 1.',
      ExitCode.usage,
    );
  }
  const renamePairs = value.renamePairs.map((pair) => {
    if (
      !isRecord(pair) ||
      !hasExactKeys(pair, ['from', 'to']) ||
      typeof pair.from !== 'string' ||
      pair.from.length === 0 ||
      typeof pair.to !== 'string' ||
      pair.to.length === 0
    ) {
      throw workflowError(
        'PROPOSE_INTENT_INVALID',
        'Propose rename pairs are malformed.',
        ExitCode.usage,
      );
    }
    return { from: pair.from, to: pair.to };
  });
  const intent: NormalizedChangeIntent = {
    schemaVersion: 1,
    summary: value.summary,
    explicitPaths: [...value.explicitPaths],
    explicitSymbols: [...value.explicitSymbols],
    explicitConfigKeys: [...value.explicitConfigKeys],
    renamePairs,
  };
  const probe: BlindSurveyManifest = {
    schemaVersion: 1,
    kind: 'blind-survey-manifest',
    changeId: 'intent-validation',
    repositoryId: 'intent-validation',
    baseCommit: '0'.repeat(40),
    baseTree: '0'.repeat(40),
    normalizedIntent: intent,
    architectureQuestion: 'Validate the normalized intent shape.',
    capabilityProfile: 'repository-read-only',
  };
  blindSurveyIntentDigest(Object.freeze(probe) as BlindSurveyManifest);
  return intent;
}

function assertProposeStartInput(value: unknown): ProposeStartInput {
  if (isRecord(value) && value.kind === 'investigation-exemption-request') {
    if (
      !hasExactKeys(value, ['schemaVersion', 'kind', 'intent', 'exemption']) ||
      value.schemaVersion !== 1 ||
      !isRecord(value.exemption) ||
      !hasExactKeys(value.exemption, [
        'category',
        'declaredPaths',
        'declaredChangeClasses',
        'rationale',
        'semanticAuthor',
        'nonTrivialBehaviorReliance',
        'researchBudgetMinutes',
      ]) ||
      typeof value.exemption.category !== 'string' ||
      !isStringArray(value.exemption.declaredPaths) ||
      !isStringArray(value.exemption.declaredChangeClasses) ||
      typeof value.exemption.rationale !== 'string' ||
      !isRecord(value.exemption.semanticAuthor) ||
      value.exemption.nonTrivialBehaviorReliance !== 'none-declared' ||
      (value.exemption.researchBudgetMinutes !== null &&
        !Number.isInteger(value.exemption.researchBudgetMinutes))
    ) {
      throw proposeInputInvalid();
    }
    return {
      schemaVersion: 1,
      kind: 'investigation-exemption-request',
      intent: assertNormalizedIntent(value.intent),
      exemption: structuredClone(
        value.exemption,
      ) as InvestigationExemptionRequest['exemption'],
    };
  }
  return assertNormalizedIntent(value);
}

function isInvestigationExemptionRequest(
  value: ProposeStartInput,
): value is InvestigationExemptionRequest {
  return (
    isRecord(value) &&
    'kind' in value &&
    value.kind === 'investigation-exemption-request'
  );
}

function readProposeAuthorization(
  paths: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  request: ProviderInvocationRequest,
): {
  actor: {
    providerId: 'codex' | 'claude';
    assurance: 'self-declared' | 'runtime-hint' | 'adapter-assigned';
  };
  signals: ActorSignal[];
  protectedBase: {
    ref: string;
    commit: string;
  };
  grantAuthorization: ProposeGrantAuthorization | null;
  legacyMigration: LegacyPlanMigrationSubject | null;
} {
  const node = readEvidenceNode(paths, request.authorizationNodeId);
  const output = node.output;
  if (
    node.type !== 'propose-authorization' ||
    node.nodeSchema !== PROPOSE_AUTHORIZATION_SCHEMA ||
    node.evaluator !== 'workflow-propose.v1' ||
    node.policyDigest !== PROPOSE_POLICY_DIGEST ||
    node.outputSchema !== PROPOSE_AUTHORIZATION_OUTPUT_SCHEMA ||
    !isRecord(output) ||
    !hasExactKeys(output, [
      'actor',
      'signals',
      'assignment',
      'grantAuthorization',
      'intent',
      'legacyMigration',
      'baseline',
      'protectedBase',
    ]) ||
    !isRecord(output.actor) ||
    !hasExactKeys(output.actor, ['providerId', 'assurance']) ||
    !['codex', 'claude'].includes(output.actor.providerId as string) ||
    !['self-declared', 'runtime-hint', 'adapter-assigned'].includes(
      output.actor.assurance as string,
    ) ||
    !Array.isArray(output.signals) ||
    !isBaseline(output.baseline) ||
    !isRecord(output.protectedBase) ||
    !hasExactKeys(output.protectedBase, ['ref', 'commit']) ||
    typeof output.protectedBase.ref !== 'string' ||
    output.protectedBase.ref.length === 0 ||
    typeof output.protectedBase.commit !== 'string' ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(output.protectedBase.commit) ||
    canonicalJson(output.baseline) !==
      canonicalJson({
        head: request.baseCommit,
        tree: request.baseTree,
      }) ||
    canonicalJson(output.assignment) !== canonicalJson(request.roleAssignment)
  ) {
    throw proposeAuthorizationInvalid();
  }
  const actor = output.actor as {
    providerId: 'codex' | 'claude';
    assurance: 'self-declared' | 'runtime-hint' | 'adapter-assigned';
  };
  const signals = output.signals.map((signal) => {
    if (
      !isRecord(signal) ||
      !hasExactKeys(signal, ['source', 'name', 'providerId', 'assurance']) ||
      !['explicit', 'runtime-hint'].includes(signal.source as string) ||
      typeof signal.name !== 'string' ||
      signal.name.length === 0 ||
      signal.providerId !== actor.providerId ||
      !['self-declared', 'runtime-hint'].includes(signal.assurance as string)
    ) {
      throw proposeAuthorizationInvalid();
    }
    return signal as ActorSignal;
  });
  const intent = assertNormalizedIntent(output.intent);
  const grantAuthorization = assertProposeGrantAuthorization(
    output.grantAuthorization,
    actor,
    request,
  );
  const legacyMigration =
    output.legacyMigration === null
      ? null
      : assertLegacyPlanMigrationSubject(output.legacyMigration);
  if (
    node.exactInputDigests.actorResolution !==
      sha256(canonicalJson({ actor, signals })) ||
    node.exactInputDigests.assignment !==
      sha256(canonicalJson(request.roleAssignment)) ||
    node.exactInputDigests.grantAuthorization !==
      sha256(canonicalJson(grantAuthorization)) ||
    node.exactInputDigests.baseline !==
      sha256(canonicalJson(output.baseline)) ||
    node.exactInputDigests.intent !== sha256(canonicalJson(intent)) ||
    node.exactInputDigests.legacyMigration !==
      sha256(canonicalJson(legacyMigration)) ||
    node.exactInputDigests.protectedBase !==
      sha256(canonicalJson(output.protectedBase))
  ) {
    throw proposeAuthorizationInvalid();
  }
  if (
    legacyMigration !== null &&
    canonicalJson(legacyMigration.baseline) !==
      canonicalJson({ head: request.baseCommit, tree: request.baseTree })
  ) {
    throw proposeAuthorizationInvalid();
  }
  return {
    actor,
    signals,
    grantAuthorization,
    legacyMigration,
    protectedBase: output.protectedBase as {
      ref: string;
      commit: string;
    },
  };
}

function assertProposeGrantAuthorization(
  value: unknown,
  actor: {
    providerId: 'codex' | 'claude';
    assurance: 'self-declared' | 'runtime-hint' | 'adapter-assigned';
  },
  request: ProviderInvocationRequest,
): ProposeGrantAuthorization | null {
  if (!('grantId' in request.roleAssignment)) {
    if (
      value !== null ||
      request.providerId === actor.providerId ||
      request.roleAssignment.requiredIndependence !== 'provider-independent' ||
      request.roleAssignment.achievedIndependence !== 'provider-independent'
    ) {
      throw proposeAuthorizationInvalid();
    }
    return null;
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['grantId', 'transitionDigest', 'expectedBinding']) ||
    typeof value.grantId !== 'string' ||
    value.grantId !== request.roleAssignment.grantId ||
    typeof value.transitionDigest !== 'string' ||
    !DIGEST.test(value.transitionDigest) ||
    !isRecord(value.expectedBinding)
  ) {
    throw proposeAuthorizationInvalid();
  }
  const expectedBinding =
    value.expectedBinding as CollaborationGrantExpectedBinding;
  if (
    request.providerId !== actor.providerId ||
    request.roleAssignment.providerId !== actor.providerId ||
    request.roleAssignment.requiredIndependence !== 'provider-independent' ||
    request.roleAssignment.achievedIndependence !== 'session-independent' ||
    expectedBinding.collaborationPolicyDigest !==
      COLLABORATION_GRANT_POLICY_DIGEST ||
    expectedBinding.baselineCommit !== request.baseCommit ||
    expectedBinding.baselineTree !== request.baseTree ||
    expectedBinding.targetDigest !== request.targetDigest ||
    expectedBinding.lifecyclePhase !== 'blind-survey' ||
    canonicalJson(expectedBinding.rolePair) !==
      canonicalJson({
        authorRole: 'investigation-author',
        conflictingRole: 'blind-surveyor',
      }) ||
    canonicalJson(expectedBinding.availableActor) !==
      canonicalJson({
        kind: 'provider',
        providerId: actor.providerId,
        assurance: actor.assurance,
      }) ||
    expectedBinding.degradedForm !== 'same-provider-fresh-session' ||
    expectedBinding.reason !== BLIND_SURVEY_GRANT_REASON ||
    collaborationTransitionDigest(expectedBinding) !== value.transitionDigest
  ) {
    throw proposeAuthorizationInvalid();
  }
  return {
    grantId: value.grantId,
    transitionDigest: value.transitionDigest,
    expectedBinding,
  };
}

function assertBlindOutput(value: unknown): {
  reference: string;
  terms: Array<{
    kind: 'literal-content' | 'literal-path' | 'symbol' | 'config-key';
    value: string;
  }>;
} {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['reference', 'terms']) ||
    typeof value.reference !== 'string' ||
    value.reference.length === 0 ||
    !Array.isArray(value.terms)
  ) {
    throw workflowError(
      'PROVIDER_OUTPUT_INVALID',
      'Blind survey output is malformed.',
      ExitCode.staleState,
    );
  }
  const kinds = new Set([
    'literal-content',
    'literal-path',
    'symbol',
    'config-key',
  ]);
  const terms = value.terms.map((term) => {
    if (
      !isRecord(term) ||
      !hasExactKeys(term, ['kind', 'value']) ||
      typeof term.kind !== 'string' ||
      !kinds.has(term.kind) ||
      typeof term.value !== 'string' ||
      term.value.length === 0
    ) {
      throw workflowError(
        'PROVIDER_OUTPUT_INVALID',
        'Blind survey terms are malformed.',
        ExitCode.staleState,
      );
    }
    return term as {
      kind: 'literal-content' | 'literal-path' | 'symbol' | 'config-key';
      value: string;
    };
  });
  return { reference: value.reference, terms };
}

function indexBehaviorContracts(
  specs: Array<{ path: string; content: string }>,
): BehaviorContractRef[] {
  const refs: BehaviorContractRef[] = [];
  for (const spec of specs) {
    let requirement: string | null = null;
    for (const line of spec.content.split('\n')) {
      const requirementMatch = /^### Requirement: (.+)$/.exec(line);
      if (requirementMatch) {
        requirement = requirementMatch[1]!.trim();
        refs.push({
          specPath: spec.path,
          requirement,
          scenario: null,
        });
        continue;
      }
      const scenarioMatch = /^#### Scenario: (.+)$/.exec(line);
      if (scenarioMatch && requirement) {
        refs.push({
          specPath: spec.path,
          requirement,
          scenario: scenarioMatch[1]!.trim(),
        });
      }
    }
  }
  return refs.sort((left, right) =>
    canonicalJson(left).localeCompare(canonicalJson(right)),
  );
}

function readCallerJson(cwd: string, requestedPath: string): unknown {
  const filePath = path.resolve(cwd, requestedPath);
  let descriptor: number | undefined;
  try {
    const before = fs.lstatSync(filePath);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size > MAX_CALLER_JSON_BYTES
    ) {
      throw new Error('unsafe caller input');
    }
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    ) {
      throw new Error('caller input changed');
    }
    const bytes = fs.readFileSync(descriptor);
    const verification = Buffer.alloc(bytes.length);
    const verificationBytes = fs.readSync(
      descriptor,
      verification,
      0,
      verification.length,
      0,
    );
    const after = fs.lstatSync(filePath);
    const finalOpened = fs.fstatSync(descriptor);
    if (
      verificationBytes !== bytes.length ||
      !verification.equals(bytes) ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      finalOpened.size !== before.size
    ) {
      throw new Error('caller input changed');
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return JSON.parse(text);
  } catch {
    throw workflowError(
      'PROPOSE_INPUT_FILE_INVALID',
      'Unable to read a bounded canonical caller input file safely.',
      ExitCode.usage,
    );
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}

function listChangeFiles(changeDirectory: string): string[] {
  if (!fs.existsSync(changeDirectory)) {
    return [];
  }
  const result: string[] = [];
  const visit = (directory: string) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const stats = fs.lstatSync(absolute);
      if (stats.isSymbolicLink()) {
        throw workflowError(
          'UNMANAGED_PLANNING_CONFLICT',
          'Planning materialization refuses symbolic links.',
          ExitCode.conflict,
        );
      }
      if (stats.isDirectory()) {
        visit(absolute);
      } else if (stats.isFile()) {
        result.push(
          path.relative(changeDirectory, absolute).split(path.sep).join('/'),
        );
      } else {
        throw workflowError(
          'UNMANAGED_PLANNING_CONFLICT',
          'Planning materialization found a non-regular path.',
          ExitCode.conflict,
        );
      }
    }
  };
  visit(changeDirectory);
  return result.sort();
}

function listSpecFiles(changeDirectory: string): string[] {
  return listChangeFiles(changeDirectory).filter(
    (relativePath) =>
      relativePath.startsWith('specs/') && relativePath.endsWith('/spec.md'),
  );
}

function uniqueNodes(nodes: EvidenceNode[]): EvidenceNode[] {
  const byId = new Map<string, EvidenceNode>();
  for (const node of nodes) {
    const existing = byId.get(node.nodeId);
    if (existing && canonicalJson(existing) !== canonicalJson(node)) {
      throw workflowError(
        'INVESTIGATION_EVIDENCE_COLLISION',
        'Investigation evidence reuses a node ID for different bytes.',
        ExitCode.conflict,
      );
    }
    byId.set(node.nodeId, node);
  }
  return [...byId.values()].sort((left, right) =>
    left.nodeId.localeCompare(right.nodeId),
  );
}

function artifactDigests(entries: Map<string, string>): Record<string, string> {
  return Object.fromEntries(
    [...entries.entries()]
      .map(([relativePath, content]) => [relativePath, sha256(content)])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function createRuntimeId(prefix: string): string {
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, '');
  return `${prefix}-${timestamp}-${crypto.randomUUID()}`;
}

function isBaseline(value: unknown): value is {
  head: string;
  tree: string;
} {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['head', 'tree']) &&
    typeof value.head === 'string' &&
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.head) &&
    typeof value.tree === 'string' &&
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.tree)
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  );
}

function isDigestRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.keys(value).length > 0 &&
    Object.entries(value).every(
      ([relativePath, digest]) =>
        relativePath.length > 0 &&
        typeof digest === 'string' &&
        DIGEST.test(digest),
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort())
  );
}

function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function proposeInputInvalid() {
  return workflowError(
    'PROPOSE_INPUT_INVALID',
    'Propose input does not match a supported typed envelope.',
    ExitCode.usage,
  );
}

function proposeAuthorizationInvalid() {
  return workflowError(
    'PROPOSE_AUTHORIZATION_INVALID',
    'Durable propose actor and role authorization evidence is invalid.',
    ExitCode.staleState,
  );
}

function planningMaterializationStale(message: string) {
  return workflowError(
    'PLANNING_MATERIALIZATION_STALE',
    message,
    ExitCode.staleState,
  );
}

function investigationPolicyInvalid(message: string) {
  return workflowError('INVESTIGATION_POLICY_INVALID', message, ExitCode.guard);
}

function planningContributionInvalid(
  message = 'Planning contribution is malformed.',
) {
  return workflowError(
    'PLANNING_CONTRIBUTION_INVALID',
    message,
    ExitCode.usage,
  );
}
