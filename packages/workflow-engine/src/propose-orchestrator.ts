import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { resolveActorIdentity, type ActorSignal } from './actor-identity.ts';
import { replaceTextAtomic } from './atomic-text.ts';
import { canonicalJson } from './canonical-json.ts';
import {
  loadChecksConfig,
  parseExecutionArtifact,
  parseInvestigationArtifact,
  parseTasks,
  type BehaviorContractRef,
  type ExecutionArtifact,
  type GuardContract,
} from './contracts.ts';
import {
  compareAndSwapEvidenceRef,
  readEvidenceNode,
  readEvidenceRefs,
  writeEvidenceNode,
} from './evidence-object-store.ts';
import { createEvidenceNode, type EvidenceNode } from './evidence-node.ts';
import { ExitCode, workflowError } from './errors.ts';
import { protectedBranchRef, runGit } from './git.ts';
import {
  deriveEngineFloor,
  derivePinnedDiffPathFacts,
  type ChangedPathFact,
  type ReviewedCounterpartFact,
} from './investigation-floor.ts';
import {
  createInvestigationCoverageNode,
  createInvestigationDispositionNodes,
  deriveInvestigationGroups,
  readInvestigationGroupNode,
  type ReviewedPathRelationship,
} from './investigation-groups.ts';
import { scanInvestigationTree } from './investigation-scanner.ts';
import {
  getInvestigationStatus,
  resumeInvestigationSession,
  startInvestigationSession,
  type InvestigationStatus,
} from './investigation-session.ts';
import {
  assertInvestigationCheckpointEnvelope,
  checkpointContributionDigest,
  readInvestigationSession,
  type InvestigationCheckpointEnvelope,
  type InvestigationSession,
} from './investigation-session-store.ts';
import {
  previewInvestigationTermUnion,
  type InvestigationTermContribution,
  type InvestigationTermRawCounts,
  type PreviewInvestigationTerm,
} from './investigation-terms.ts';
import {
  createInvestigationWhyNodes,
  deriveInvestigationFullBlobManifest,
  type InvestigationFullBlobManifestEntry,
} from './investigation-why.ts';
import { projectInvestigationLedger } from './investigation-design-projection.ts';
import { loadInvestigationRuntimeContext } from './lifecycle-context.ts';
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
import { assertChangeId, normalizePolicyPath } from './paths.ts';
import { withInvestigationTransitionAuthority } from './planning-lock.ts';
import {
  createProviderInvocationRequest,
  type ProviderInvocationRequest,
  type ProviderProcessResult,
} from './provider-contracts.ts';
import {
  BLIND_SURVEY_OUTPUT_SCHEMA,
  blindSurveyIntentDigest,
  blindSurveyManifestDigest,
  readBlindSurveyManifest,
  readProviderInvocation,
  readProviderInvocationRequest,
  type BlindSurveyManifest,
  type NormalizedChangeIntent,
} from './provider-invocation-store.ts';
import { scheduleOrdinaryRole } from './role-scheduler.ts';
import {
  readPinnedTrackedTree,
  type TrackedTreeSnapshot,
} from './tracked-tree-reader.ts';

const MAX_CALLER_JSON_BYTES = 4 * 1024 * 1024;
const DIGEST = /^[0-9a-f]{64}$/;
const PROPOSE_POLICY_DIGEST = sha256(
  canonicalJson({ schema: 'workflow-propose-policy.v1' }),
);
const PROPOSE_AUTHORIZATION_SCHEMA = 'workflow-propose-authorization.v1';
const PLANNING_MATERIALIZATION_REF = 'propose/planning-materialization';

export type ProposeProviderDriver = (input: {
  paths: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'];
  request: ProviderInvocationRequest;
}) => void;

export type ProposeOptions = {
  explicitActor?: string;
  environment?: Record<string, string | undefined>;
  providerDriver?: ProposeProviderDriver;
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

export type ProposeInput =
  | InvestigationCheckpointEnvelope
  | PlanningContributionEnvelope
  | ProviderProgressEnvelope;

export type ProposeGroupWork = {
  groupId: string;
  termId: string;
  paths: string[];
  hitIds: string[];
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
    | 'plan-review-required';
  nextAction:
    | InvestigationStatus['nextAction']
    | 'submit-planning-contribution'
    | 'obtain-plan-review';
  investigation: InvestigationStatus | null;
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
};

type RebuiltInvestigation = {
  session: InvestigationSession;
  intent: NormalizedChangeIntent;
  floor: ReturnType<typeof deriveEngineFloor>;
  termSources: InvestigationTermRawCounts;
  authorizationNode: EvidenceNode;
  providerResultNode: EvidenceNode | null;
  contributionNodes: EvidenceNode[];
  termUnionNode: EvidenceNode | null;
  scanNodes: EvidenceNode[];
  inventoryNode: EvidenceNode | null;
  hitNodes: EvidenceNode[];
  groupNodes: EvidenceNode[];
  dispositionNodes: EvidenceNode[];
  coverageNode: EvidenceNode | null;
  fullBlobManifest: InvestigationFullBlobManifestEntry[];
  whyNodes: EvidenceNode[];
};

export function startPropose(
  cwd: string,
  requestedChangeId: string,
  intentInput: unknown,
  options: ProposeOptions = {},
): ProposeOutput {
  const changeId = assertChangeId(requestedChangeId);
  const intent = assertNormalizedIntent(intentInput);
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
    };
  }

  const context = loadInvestigationRuntimeContext(cwd);
  const intentDigest = sha256(canonicalJson(intent));
  const invocationId = createRuntimeId('invocation');
  const providerSessionId = createRuntimeId('provider-session');
  const candidates = (['codex', 'claude'] as const).map((providerId) => ({
    providerId,
    sessionId:
      providerId === actorResolution.actor.providerId
        ? `author-${providerSessionId}`
        : providerSessionId,
    enabled: true,
    available: true,
  }));
  const scheduled = scheduleOrdinaryRole({
    role: 'blind-surveyor',
    author: {
      providerId: actorResolution.actor.providerId,
      sessionId: `author-${actorResolution.actor.providerId}`,
      principalId: undefined,
      identityAssurance: actorResolution.actor.assurance,
      engineSpawned: false,
    },
    targetDigest: intentDigest,
    candidates,
  });
  if (scheduled.outcome !== 'assigned') {
    throw workflowError(
      'COLLABORATION_GRANT_REQUIRED',
      'No provider-independent blind surveyor is currently assignable.',
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
  if (!/^[0-9a-f]{40}$/.test(protectedBaseCommit)) {
    throw workflowError(
      'PROPOSE_BASE_REF_INVALID',
      'The configured protected base did not resolve to an exact commit.',
      ExitCode.staleState,
    );
  }

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
      assignment: sha256(canonicalJson(scheduled.assignment)),
      baseline: sha256(
        canonicalJson({ head: context.git.head, tree: context.git.tree }),
      ),
      intent: intentDigest,
      protectedBase: sha256(
        canonicalJson({
          ref: protectedBaseRef,
          commit: protectedBaseCommit,
        }),
      ),
    },
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: 'workflow-propose-authorization-output.v1',
    output: {
      actor: actorResolution.actor,
      signals: actorResolution.signals,
      assignment: scheduled.assignment,
      intent,
      baseline: { head: context.git.head, tree: context.git.tree },
      protectedBase: {
        ref: protectedBaseRef,
        commit: protectedBaseCommit,
      },
    },
    runtimeMetadata: {},
  });
  writeEvidenceNode(context.runtime, authorizationNode);
  const request = createProviderInvocationRequest({
    invocationId,
    nonce: `propose-${crypto.randomUUID()}`,
    purpose: 'survey',
    providerId: scheduled.assignment.providerId,
    roleAssignment: scheduled.assignment,
    capabilityProfile: 'repository-read-only',
    repositoryId: context.config.repositoryName,
    baseCommit: context.git.head,
    baseTree: context.git.tree,
    targetDigest: intentDigest,
    inputManifestDigest: manifestDigest,
    authorizationNodeId: authorizationNode.nodeId,
    writeAllowedPaths: [],
    outputSchema: BLIND_SURVEY_OUTPUT_SCHEMA,
    evaluatorVersion: 'blind-survey-evaluator.v1',
    policyDigest: PROPOSE_POLICY_DIGEST,
    limits: {
      timeoutMs: 300_000,
      aggregateOutputBytes: 1_048_576,
    },
  });
  const status = startInvestigationSession(cwd, {
    changeId,
    blindManifest: manifest,
    blindRequest: request,
  });
  const durableInvocation = readProviderInvocation(
    context.runtime,
    status.providerInvocationId,
  );
  const durableRequest = readProviderInvocationRequest(
    context.runtime,
    status.providerInvocationId,
  );
  const durableAuthorization = readProposeAuthorization(
    context.runtime,
    durableRequest,
  );
  if (
    durableAuthorization.actor.providerId !== actorResolution.actor.providerId
  ) {
    throw workflowError(
      'CURRENT_INVESTIGATION_ACTOR_CONFLICT',
      'The current investigation is pinned to a different actor.',
      ExitCode.conflict,
    );
  }
  if (
    options.providerDriver &&
    durableInvocation.state === 'prepared' &&
    status.providerInvocationId === request.invocationId
  ) {
    options.providerDriver({ paths: context.runtime, request });
  }

  return renderProposeOutputWithPlanningAuthority(cwd, status, {
    outcome: 'resolved',
    providerId: durableAuthorization.actor.providerId,
    assurance: durableAuthorization.actor.assurance,
    signals: durableAuthorization.signals,
  });
}

export function resumePropose(
  cwd: string,
  requestedChangeId: string,
  inputValue: unknown,
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
  if (input.kind === 'planning-contribution') {
    const initialContext = loadInvestigationRuntimeContext(cwd);
    return withInvestigationTransitionAuthority(
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
        const rebuilt = rebuildInvestigation(cwd, status.investigationId);
        assertOwned();
        const materializedArtifacts = materializePlanningContribution(
          cwd,
          status,
          rebuilt,
          input.payload,
        );
        assertOwned();
        const current = getInvestigationStatus(cwd, input.investigationId);
        assertPlanningBinding(current, input);
        return renderProposeOutput(cwd, current, null, materializedArtifacts);
      },
    );
  }

  if (input.kind === 'provider-progress') {
    const current = getInvestigationStatus(cwd, input.investigationId);
    assertProgressBinding(current, input);
    if (current.revision !== input.expectedRevision) {
      throw workflowError(
        'INVESTIGATION_CAS_MISMATCH',
        'Investigation session changed during provider progress.',
        ExitCode.conflict,
      );
    }
    const resumed = resumeInvestigationSession(cwd, input.investigationId);
    return renderProposeOutputWithPlanningAuthority(cwd, resumed);
  }

  const checkpoint = assertInvestigationCheckpointEnvelope(input);
  const before = getInvestigationStatus(cwd, checkpoint.investigationId);
  if (checkpoint.kind === 'group-dispositions') {
    const rebuilt = rebuildInvestigation(cwd, before.investigationId);
    createInvestigationDispositionNodes({
      groupNodes: rebuilt.groupNodes,
      dispositions: checkpoint.payload.dispositions,
    });
  } else if (checkpoint.kind === 'why-answers') {
    const rebuilt = rebuildInvestigation(cwd, before.investigationId);
    createInvestigationWhyNodes({
      manifest: rebuilt.fullBlobManifest,
      hitNodes: rebuilt.hitNodes,
      groupNodes: rebuilt.groupNodes,
      dispositionNodes: rebuilt.dispositionNodes,
      answers: checkpoint.payload.answers,
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
  return renderProposeOutputWithPlanningAuthority(cwd, status);
}

export function createPlanningContributionEnvelope(
  output: ProposeOutput,
  payload: PlanningContributionPayload,
): PlanningContributionEnvelope {
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
): ProposeOutput {
  return resumePropose(cwd, changeId, readCallerJson(cwd, inputPath));
}

export function getProposeStatus(
  cwd: string,
  requestedInvestigationId: string,
): ProposeOutput {
  const status = getInvestigationStatus(cwd, requestedInvestigationId);
  const rebuilt = rebuildInvestigation(cwd, status.investigationId);
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
    return renderProposeOutput(cwd, status, actorResolution);
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
    };
  }
  return {
    schemaVersion: 1,
    kind: 'workflow-propose',
    changeId: status.changeId,
    state: 'plan-review-required',
    nextAction: 'obtain-plan-review',
    investigation: status,
    createdDate,
    actorResolution,
    inputSchema: null,
    work: workFromRebuilt(rebuilt, []),
    materializedArtifacts: materialized,
  };
}

function renderProposeOutputWithPlanningAuthority(
  cwd: string,
  status: InvestigationStatus,
  actorResolution: ProposeOutput['actorResolution'] = null,
): ProposeOutput {
  if (status.state !== 'investigation-sealed') {
    return renderProposeOutput(cwd, status, actorResolution);
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
      const result = renderProposeOutput(cwd, current, actorResolution);
      assertOwned();
      return result;
    },
  );
}

function renderProposeOutput(
  cwd: string,
  status: InvestigationStatus,
  actorResolution: ProposeOutput['actorResolution'] = null,
  knownMaterializedArtifacts?: Record<string, string>,
): ProposeOutput {
  const rebuilt = rebuildInvestigation(cwd, status.investigationId);
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
      return {
        schemaVersion: 1,
        kind: 'workflow-propose',
        changeId: status.changeId,
        state: 'plan-review-required',
        nextAction: 'obtain-plan-review',
        investigation: status,
        createdDate,
        actorResolution,
        inputSchema: null,
        work: workFromRebuilt(rebuilt, receiptLookup.instructions),
        materializedArtifacts: materialized,
      };
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
    inputSchema: inputSchemaForStatus(status),
    work: workFromRebuilt(rebuilt, []),
    materializedArtifacts: null,
  };
}

function rebuildInvestigation(
  cwd: string,
  investigationId: string,
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
    return emptyRebuilt(session, intent, floor, emptyCounts, authorizationNode);
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
  ];
  const contributionNodes = contributions.map((contribution) =>
    createTermContributionNode(session, contribution),
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
      dispositions: stored.payload.dispositions,
    });
  }
  const fullBlobManifest =
    session.milestones.groupDispositions === null
      ? []
      : deriveInvestigationFullBlobManifest({
          snapshot,
          hitNodes: grouped.hitNodes,
          groupNodes: grouped.groupNodes,
          dispositionNodes,
        });
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
    providerResultNode,
    contributionNodes,
    termUnionNode,
    scanNodes: scan.nodes,
    inventoryNode: scan.inventory.evidenceNode,
    hitNodes: grouped.hitNodes,
    groupNodes: grouped.groupNodes,
    dispositionNodes,
    coverageNode,
    fullBlobManifest,
    whyNodes,
  };
}

function emptyRebuilt(
  session: InvestigationSession,
  intent: NormalizedChangeIntent,
  floor: ReturnType<typeof deriveEngineFloor>,
  termSources: InvestigationTermRawCounts,
  authorizationNode: EvidenceNode,
): RebuiltInvestigation {
  return {
    session,
    intent,
    floor,
    termSources,
    authorizationNode,
    providerResultNode: null,
    contributionNodes: [],
    termUnionNode: null,
    scanNodes: [],
    inventoryNode: null,
    hitNodes: [],
    groupNodes: [],
    dispositionNodes: [],
    coverageNode: null,
    fullBlobManifest: [],
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
  return {
    termSources: rebuilt.termSources,
    groups: rebuilt.groupNodes.map((node) => {
      const group = readInvestigationGroupNode(node);
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
      };
    }),
    fullBlobManifest: rebuilt.fullBlobManifest.map((entry) => ({
      manifestEntryId: entry.manifestEntryId,
      path: entry.path.utf8 ?? `base64:${entry.path.rawBase64}`,
      objectId: entry.blob.objectId,
      contentSha256: entry.blob.contentSha256,
      contentBase64: entry.blob.contentBase64,
    })),
    authoredInstructions,
  };
}

function createTermContributionNode(
  session: InvestigationSession,
  contribution: InvestigationTermContribution,
): EvidenceNode {
  return createEvidenceNode({
    type: 'investigation-term-contribution',
    nodeSchema: 'investigation.term-contribution.v1',
    evaluator: 'workflow-propose.v1',
    policyDigest: PROPOSE_POLICY_DIGEST,
    exactInputDigests: {
      baseline: sha256(canonicalJson(session.baseline)),
      contribution: sha256(canonicalJson(contribution)),
    },
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: 'investigation.term-contribution-output.v1',
    output: contribution,
    runtimeMetadata: {},
  });
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
    nodeSchema: 'investigation.term-union.v1',
    evaluator: 'workflow-propose.v1',
    policyDigest: PROPOSE_POLICY_DIGEST,
    exactInputDigests: {
      baseline: sha256(canonicalJson(session.baseline)),
      terms: sha256(canonicalJson(terms)),
    },
    semanticParentResultDigests,
    provenanceParentNodeIds,
    outputSchema: 'investigation.term-union-output.v1',
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

function preparePlanningScaffold(
  cwd: string,
  status: InvestigationStatus,
  rebuilt: RebuiltInvestigation,
  createdDate: string,
  allowAuthoredExisting = false,
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
  const metadataBytes = `schema: expense-app-v2\ncreated: ${createdDate}\n`;
  const sealNode = createInvestigationSealNode(rebuilt);
  const nodes = uniqueNodes([
    rebuilt.authorizationNode,
    ...(rebuilt.providerResultNode === null
      ? []
      : [rebuilt.providerResultNode]),
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
      legacyMigration: false,
      nodes,
      currentRefs: {
        coverage: rebuilt.coverageNode.nodeId,
        sealedInvestigation: sealNode.nodeId,
      },
    },
    status.changeId,
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
  );
  writeMissingEntries(changeDirectory, scaffoldEntries);

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
  provenance.providerResult = rebuilt.providerResultNode.nodeId;
  semantic.providerResult = rebuilt.providerResultNode.resultDigest;
  provenance.termUnion = rebuilt.termUnionNode.nodeId;
  semantic.termUnion = rebuilt.termUnionNode.resultDigest;
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

function materializePlanningContribution(
  cwd: string,
  status: InvestigationStatus,
  rebuilt: RebuiltInvestigation,
  payloadInput: unknown,
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
  const tasks = parseTasks(payload.tasks);
  if (tasks.length === 0 || tasks.some(({ completed }) => completed)) {
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
      `schema: expense-app-v2\ncreated: ${rebuilt.session.createdAt.slice(0, 10)}\n`,
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
): void {
  const node = createEvidenceNode({
    type: 'propose-planning-materialization',
    nodeSchema: 'workflow.propose-planning-materialization.v1',
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
    outputSchema: 'workflow.propose-planning-materialization-output.v1',
    output: {
      investigationId: status.investigationId,
      changeId: status.changeId,
      revision: status.revision,
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
  if (current !== null) {
    throw workflowError(
      'PLANNING_MATERIALIZATION_CONFLICT',
      'A different planning materialization is already current.',
      ExitCode.conflict,
    );
  }
  compareAndSwapEvidenceRef(paths, {
    changeId: status.changeId,
    refName: PLANNING_MATERIALIZATION_REF,
    expectedNodeId: null,
    nextNodeId: node.nodeId,
  });
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
  if (
    node.type !== 'propose-planning-materialization' ||
    node.nodeSchema !== 'workflow.propose-planning-materialization.v1' ||
    node.evaluator !== 'workflow-propose.v1' ||
    node.policyDigest !== PROPOSE_POLICY_DIGEST ||
    node.outputSchema !==
      'workflow.propose-planning-materialization-output.v1' ||
    !isRecord(output) ||
    !hasExactKeys(output, [
      'investigationId',
      'changeId',
      'revision',
      'baseline',
      'artifacts',
      'sealNodeId',
      'sealResultDigest',
    ]) ||
    output.investigationId !== status.investigationId ||
    output.changeId !== status.changeId ||
    output.revision !== status.revision ||
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
  if (fs.existsSync(path.join(scaffold.changeDirectory, 'plan-review.json'))) {
    throw planningMaterializationStale(
      'Task 5.2 cannot reinterpret a later PlanReview transition.',
    );
  }
  const adapter = createOpenSpecAdapter(context.git.repositoryRoot);
  const openspecStatus = adapter.status(status.changeId, 'expense-app-v2');
  if (
    openspecStatus.isComplete ||
    openspecStatus.artifacts.find(({ id }) => id === 'plan-review')?.status !==
      'ready'
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
  assertPlanningTargetsCompatible(scaffold.changeDirectory, entries, false);
  const observed = artifactDigests(entries);
  if (canonicalJson(observed) !== canonicalJson(receipt)) {
    throw planningMaterializationStale(
      'Current planning bytes differ from durable materialization evidence.',
    );
  }
  return observed;
}

function assertPlanningTargetsCompatible(
  changeDirectory: string,
  entries: Map<string, string>,
  scaffoldOnly: boolean,
  allowAuthoredExisting = false,
): void {
  const allowedExisting = new Set(entries.keys());
  const existing = listChangeFiles(changeDirectory);
  for (const relativePath of existing) {
    if (!allowedExisting.has(relativePath)) {
      if (scaffoldOnly) {
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
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      fs.readFileSync(target, 'utf8') !== expected
    ) {
      throw workflowError(
        'UNMANAGED_PLANNING_CONFLICT',
        'Existing planning bytes differ from the managed projection.',
        ExitCode.conflict,
      );
    }
  }
}

function writeMissingEntries(
  changeDirectory: string,
  entries: Map<string, string>,
): void {
  for (const [relativePath, content] of entries) {
    const target = path.join(changeDirectory, relativePath);
    if (!fs.existsSync(target)) {
      replaceTextAtomic(target, content, {
        allowCreate: true,
        defaultMode: 0o644,
      });
    }
  }
}

function inputSchemaForStatus(
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

function assertProposeInput(value: unknown): ProposeInput {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw proposeInputInvalid();
  }
  if (value.kind === 'planning-contribution') {
    return assertPlanningContributionEnvelope(value);
  }
  if (value.kind === 'provider-progress') {
    return assertProviderProgressEnvelope(value);
  }
  return assertInvestigationCheckpointEnvelope(value);
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
} {
  const node = readEvidenceNode(paths, request.authorizationNodeId);
  const output = node.output;
  if (
    node.type !== 'propose-authorization' ||
    node.nodeSchema !== PROPOSE_AUTHORIZATION_SCHEMA ||
    node.evaluator !== 'workflow-propose.v1' ||
    node.policyDigest !== PROPOSE_POLICY_DIGEST ||
    node.outputSchema !== 'workflow-propose-authorization-output.v1' ||
    !isRecord(output) ||
    !hasExactKeys(output, [
      'actor',
      'signals',
      'assignment',
      'intent',
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
    !/^[0-9a-f]{40}$/.test(output.protectedBase.commit) ||
    canonicalJson(output.baseline) !==
      canonicalJson({
        head: request.baseCommit,
        tree: request.baseTree,
      }) ||
    canonicalJson(output.assignment) !==
      canonicalJson(request.roleAssignment) ||
    request.providerId === output.actor.providerId ||
    request.roleAssignment.requiredIndependence !== 'provider-independent' ||
    request.roleAssignment.achievedIndependence !== 'provider-independent'
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
  if (
    node.exactInputDigests.actorResolution !==
      sha256(canonicalJson({ actor, signals })) ||
    node.exactInputDigests.assignment !==
      sha256(canonicalJson(request.roleAssignment)) ||
    node.exactInputDigests.baseline !==
      sha256(canonicalJson(output.baseline)) ||
    node.exactInputDigests.intent !== sha256(canonicalJson(intent)) ||
    node.exactInputDigests.protectedBase !==
      sha256(canonicalJson(output.protectedBase))
  ) {
    throw proposeAuthorizationInvalid();
  }
  return {
    actor,
    signals,
    protectedBase: output.protectedBase as {
      ref: string;
      commit: string;
    },
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
    /^[0-9a-f]{40}$/.test(value.head) &&
    typeof value.tree === 'string' &&
    /^[0-9a-f]{40}$/.test(value.tree)
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

function sha256(value: string): string {
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
