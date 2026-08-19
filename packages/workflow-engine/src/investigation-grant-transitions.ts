import { canonicalJson } from './foundation/canonical-json/canonical-json.ts';
import { isRecord } from './foundation/canonical-json/contract-values.ts';
import {
  ExitCode,
  WorkflowError,
  workflowError,
} from './foundation/errors/errors.ts';
import type {
  GrantRequestInput,
  StateBinding,
} from './modules/authority/grant-core.ts';
import {
  freezeGrantCanonical as freezeCanonical,
  grantHasExactKeys as hasExactKeys,
  grantSha256 as sha256,
} from './modules/authority/grant-primitives.ts';
import {
  executeGrantCoreHumanResolution,
  type GrantCoreHumanResolutionAuthorization,
} from './investigation-session.ts';
import {
  humanResolutionDecisionSchemaDigest,
  inspectInvestigationQuarantineState,
  inspectInvestigationResolutionState,
  type HumanResolutionConsequences,
  type HumanResolutionDecision,
  type HumanResolutionExpectedState,
  type HumanResolutionTarget,
  type InvestigationResolutionState,
} from './investigation-session-store.ts';
import {
  WORKFLOW_SUPERSEDE_REASONS,
  type WorkflowSupersedeReason,
} from './modules/authority/intervention-control.ts';
import { loadInvestigationRuntimeContext } from './lifecycle-context.ts';
import {
  humanResolutionBlockerBinding,
  loadMaintainerPolicyForResolution,
} from './modules/authority/maintainer-grant.ts';
import { assertChangeId, assertInvestigationId } from './paths.ts';
import { runGit } from './git.ts';
import type {
  TransitionDefinition,
  TransitionOutcome,
  TrustedChoicePresentation,
} from './modules/authority/grant-transition-registry.ts';

const GIT_OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const RAW_DIGEST = /^[0-9a-f]{64}$/;
const SUPPORTED_KINDS = [
  'resume-with-capability',
  'close-input',
  'abort',
  'quarantine',
  'supersede',
  'waive-assurance',
] as const;

type SupportedInvestigationResolutionKind = (typeof SUPPORTED_KINDS)[number];

export type InvestigationGrantRequestFacts = Readonly<{
  schemaVersion: 1;
  workflowKind: 'investigation';
  repositoryId: string;
  repositoryHead: string;
  repositoryTree: string;
  changeId: string;
  investigationId: string;
  effectiveState: InvestigationResolutionState['effectiveState'];
  blocker: InvestigationResolutionState['blocker'];
  availableResolutions: InvestigationResolutionState['availableResolutions'];
}>;

type InvestigationGrantTransitionParameters = Readonly<{
  schemaVersion: 1;
  decisionKind: SupportedInvestigationResolutionKind;
  repositoryId: string;
  repositoryHead: string;
  repositoryTree: string;
  target: HumanResolutionTarget;
  expected: HumanResolutionExpectedState;
  supersedeReason: WorkflowSupersedeReason | null;
}>;

export function createInvestigationGrantRequest(
  cwd: string,
  requestedInvestigationId: string,
  proposedReason: string,
): GrantRequestInput<InvestigationGrantRequestFacts> {
  const context = loadInvestigationRuntimeContext(cwd);
  const investigationId = assertInvestigationId(requestedInvestigationId);
  const { policy } = loadMaintainerPolicyForResolution(
    context.git.repositoryRoot,
    context.git.head,
  );
  const origin = runGit(context.git.repositoryRoot, [
    'remote',
    'get-url',
    'origin',
  ]).trim();
  if (origin !== policy.repository.origin) {
    throw workflowError(
      'HUMAN_RESOLUTION_REPOSITORY_MISMATCH',
      'The repository origin does not match the bound resolution namespace.',
      ExitCode.guard,
    );
  }
  let state: InvestigationResolutionState;
  try {
    state = inspectInvestigationResolutionState(
      context.runtime,
      investigationId,
      policy.repository.id,
    );
  } catch (error) {
    if (
      !(error instanceof WorkflowError) ||
      error.exitCode !== ExitCode.unsafeEnvironment
    ) {
      throw error;
    }
    state = inspectInvestigationQuarantineState(
      context.runtime,
      investigationId,
      policy.repository.id,
    );
  }
  return createInvestigationGrantRequestFromState({
    repositoryId: policy.repository.id,
    repositoryHead: context.git.head,
    repositoryTree: context.git.tree,
    proposedReason,
    state,
  });
}

export function createInvestigationGrantRequestFromState(
  input: Readonly<{
    repositoryId: string;
    repositoryHead: string;
    repositoryTree: string;
    proposedReason: string;
    state: InvestigationResolutionState;
  }>,
): GrantRequestInput<InvestigationGrantRequestFacts> {
  const { state } = input;
  if (
    input.repositoryId !== state.envelope.repositoryId ||
    !GIT_OBJECT_ID.test(input.repositoryHead) ||
    !GIT_OBJECT_ID.test(input.repositoryTree) ||
    state.availableResolutions.length < 1
  ) {
    throw investigationGrantInvalid(
      'INVESTIGATION_GRANT_STATE_INVALID',
      'Investigation state cannot produce a bounded grant challenge.',
    );
  }
  const target: HumanResolutionTarget = {
    workflowKind: 'investigation',
    changeId: assertChangeId(state.envelope.changeId),
    workflowId: assertInvestigationId(state.envelope.investigationId),
  };
  const blocker = humanResolutionBlockerBinding(state);
  const expected: HumanResolutionExpectedState = {
    ...blocker,
    stateDigest: state.currentStateDigest,
    currentRefDigest: state.currentRefDigest,
  };
  const common = {
    schemaVersion: 1 as const,
    repositoryId: input.repositoryId,
    repositoryHead: input.repositoryHead,
    repositoryTree: input.repositoryTree,
    target,
    expected,
  };
  const candidates = state.availableResolutions.flatMap((availability) => {
    if (
      availability.parameterSchemaDigest !==
      humanResolutionDecisionSchemaDigest(availability.kind)
    ) {
      throw investigationGrantInvalid(
        'INVESTIGATION_GRANT_SCHEMA_CHANGED',
        'An advertised investigation resolution has a mismatched schema.',
      );
    }
    if (availability.kind === 'repair') {
      throw investigationGrantInvalid(
        'INVESTIGATION_GRANT_RESOLUTION_UNSUPPORTED',
        'Typed current-ref repair requires an enumerated successor choice.',
      );
    }
    if (!isSupportedKind(availability.kind)) {
      return [];
    }
    const kind = availability.kind;
    const reasons = kind === 'supersede' ? WORKFLOW_SUPERSEDE_REASONS : [null];
    return reasons.map((supersedeReason) => ({
      transitionId: transitionIdFor(kind),
      parameters: {
        ...common,
        decisionKind: kind,
        supersedeReason,
      },
      allowedReasonCodes: [reasonCodeFor(kind)],
      reasonRequired: true,
      proposedReason: input.proposedReason,
    }));
  });
  if (candidates.length < 1) {
    throw investigationGrantInvalid(
      'INVESTIGATION_GRANT_RESOLUTION_UNSUPPORTED',
      'Investigation has no registered human resolution transition.',
    );
  }
  return freezeCanonical({
    sourceModuleId: 'investigation',
    failureCode: 'investigation-human-action-required',
    facts: {
      schemaVersion: 1,
      workflowKind: 'investigation',
      repositoryId: input.repositoryId,
      repositoryHead: input.repositoryHead,
      repositoryTree: input.repositoryTree,
      changeId: target.changeId,
      investigationId: target.workflowId,
      effectiveState: state.effectiveState,
      blocker: state.blocker,
      availableResolutions: state.availableResolutions,
    },
    stateBinding: investigationStateBinding(
      input.repositoryHead,
      input.repositoryTree,
      state.currentStateDigest,
    ),
    candidates,
  });
}

export function investigationGrantTransitionDefinitions(
  cwd: string,
): readonly TransitionDefinition<InvestigationGrantTransitionParameters>[] {
  return SUPPORTED_KINDS.map((kind) => investigationDefinition(cwd, kind));
}

function investigationDefinition(
  cwd: string,
  kind: SupportedInvestigationResolutionKind,
): TransitionDefinition<InvestigationGrantTransitionParameters> {
  return Object.freeze({
    transitionId: transitionIdFor(kind),
    parameterSchemaDigest: sha256(
      canonicalJson({
        schema: 'investigation-grant-transition-parameters.v1',
        decisionKind: kind,
        supersedeReasons:
          kind === 'supersede' ? WORKFLOW_SUPERSEDE_REASONS : null,
      }),
    ),
    consequenceDigest: sha256(
      canonicalJson({
        schema: 'investigation-grant-transition-consequences.v1',
        decisionKind: kind,
        rendererVersion: 1,
      }),
    ),
    resolutionKind: kind === 'resume-with-capability' ? 'retry' : 'non-retry',
    validateParameters(value) {
      return validateParameters(value, kind);
    },
    renderTrustedChoice(parameters) {
      return trustedPresentation(kind, parameters.supersedeReason);
    },
    observeState(parameters) {
      const observed = observeInvestigationState(cwd, parameters, kind);
      return investigationStateBinding(
        observed.repositoryHead,
        observed.repositoryTree,
        observed.state.currentStateDigest,
      );
    },
    async execute(context): Promise<TransitionOutcome> {
      const decision = decisionFor(
        kind,
        context.parameters.supersedeReason,
        context.approvalSubject.reason,
      );
      const consequences = consequencesFor(kind);
      const authorization: GrantCoreHumanResolutionAuthorization = {
        schemaVersion: 1,
        kind: 'grant-core-human-resolution.v1',
        challengeId: context.challengeId,
        approvalSubjectDigest: context.approvalSubjectDigest,
        repositoryId: context.parameters.repositoryId,
        repositoryHead: context.parameters.repositoryHead,
        repositoryTree: context.parameters.repositoryTree,
        target: context.parameters.target,
        expected: context.parameters.expected,
        decision,
        consequences,
      };
      const result = executeGrantCoreHumanResolution(
        cwd,
        authorization,
        context.assertLifecycleOwned,
      );
      return {
        outcome: 'completed',
        details: {
          resolutionNodeId: result.resolutionNodeId,
          afterStateDigest: result.afterStateDigest,
          recovered: context.recovered || result.recovered,
        },
      };
    },
  });
}

function observeInvestigationState(
  cwd: string,
  parameters: InvestigationGrantTransitionParameters,
  kind: SupportedInvestigationResolutionKind,
): Readonly<{
  repositoryHead: string;
  repositoryTree: string;
  state: InvestigationResolutionState;
}> {
  const context = loadInvestigationRuntimeContext(cwd);
  const { policy } = loadMaintainerPolicyForResolution(
    context.git.repositoryRoot,
    context.git.head,
  );
  if (policy.repository.id !== parameters.repositoryId) {
    throw workflowError(
      'HUMAN_RESOLUTION_REPOSITORY_MISMATCH',
      'The registered investigation transition observed another repository.',
      ExitCode.guard,
    );
  }
  const state =
    kind === 'quarantine'
      ? inspectInvestigationQuarantineState(
          context.runtime,
          parameters.target.workflowId,
          parameters.repositoryId,
        )
      : inspectInvestigationResolutionState(
          context.runtime,
          parameters.target.workflowId,
          parameters.repositoryId,
        );
  if (state.envelope.changeId !== parameters.target.changeId) {
    throw workflowError(
      'GRANT_STATE_CHANGED',
      'The registered investigation target changed.',
      ExitCode.staleState,
    );
  }
  return {
    repositoryHead: context.git.head,
    repositoryTree: context.git.tree,
    state,
  };
}

function validateParameters(
  value: unknown,
  expectedKind: SupportedInvestigationResolutionKind,
): InvestigationGrantTransitionParameters {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'decisionKind',
      'repositoryId',
      'repositoryHead',
      'repositoryTree',
      'target',
      'expected',
      'supersedeReason',
    ]) ||
    value.schemaVersion !== 1 ||
    value.decisionKind !== expectedKind ||
    typeof value.repositoryId !== 'string' ||
    value.repositoryId.trim() !== value.repositoryId ||
    value.repositoryId.length < 1 ||
    Buffer.byteLength(value.repositoryId) > 1_024 ||
    typeof value.repositoryHead !== 'string' ||
    !GIT_OBJECT_ID.test(value.repositoryHead) ||
    typeof value.repositoryTree !== 'string' ||
    !GIT_OBJECT_ID.test(value.repositoryTree) ||
    !isRecord(value.target) ||
    !hasExactKeys(value.target, ['workflowKind', 'changeId', 'workflowId']) ||
    value.target.workflowKind !== 'investigation' ||
    typeof value.target.changeId !== 'string' ||
    typeof value.target.workflowId !== 'string' ||
    !isRecord(value.expected) ||
    !hasExactKeys(value.expected, [
      'reasonCode',
      'blockedTransition',
      'stateDigest',
      'currentRefDigest',
    ]) ||
    typeof value.expected.reasonCode !== 'string' ||
    typeof value.expected.blockedTransition !== 'string' ||
    typeof value.expected.stateDigest !== 'string' ||
    !RAW_DIGEST.test(value.expected.stateDigest) ||
    (value.expected.currentRefDigest !== null &&
      (typeof value.expected.currentRefDigest !== 'string' ||
        !RAW_DIGEST.test(value.expected.currentRefDigest))) ||
    (expectedKind === 'supersede'
      ? !WORKFLOW_SUPERSEDE_REASONS.includes(
          value.supersedeReason as WorkflowSupersedeReason,
        )
      : value.supersedeReason !== null)
  ) {
    throw investigationGrantInvalid(
      'INVESTIGATION_GRANT_PARAMETERS_INVALID',
      'Investigation transition parameters are malformed.',
    );
  }
  assertChangeId(value.target.changeId);
  assertInvestigationId(value.target.workflowId);
  return freezeCanonical(value) as InvestigationGrantTransitionParameters;
}

function decisionFor(
  kind: SupportedInvestigationResolutionKind,
  supersedeReason: WorkflowSupersedeReason | null,
  humanReason: string,
): HumanResolutionDecision {
  switch (kind) {
    case 'resume-with-capability':
      return {
        kind,
        capability: 'reviewer-term-reopen',
        parameters: { additionalUses: 1 },
      };
    case 'close-input':
      return { kind, input: 'reviewer-terms', parameters: {} };
    case 'abort':
      return { kind, parameters: {} };
    case 'quarantine':
      return { kind, parameters: { reason: humanReason } };
    case 'supersede':
      if (supersedeReason === null) {
        throw investigationGrantInvalid(
          'INVESTIGATION_GRANT_PARAMETERS_INVALID',
          'Supersede requires one code-owned semantic reason choice.',
        );
      }
      return {
        kind,
        parameters: { successorInvestigationId: null, reason: supersedeReason },
      };
    case 'waive-assurance':
      return {
        kind,
        claim: 'reviewer-term-incorporation',
        parameters: {},
      };
  }
}

function consequencesFor(
  kind: SupportedInvestigationResolutionKind,
): HumanResolutionConsequences {
  switch (kind) {
    case 'resume-with-capability':
      return {
        continuity: 'preserved',
        assurance: 'unchanged',
        claimsWaived: [],
      };
    case 'close-input':
      return {
        continuity: 'preserved',
        assurance: 'degraded',
        claimsWaived: ['reviewer-term-incorporation'],
      };
    case 'abort':
    case 'supersede':
      return { continuity: 'broken', assurance: 'degraded', claimsWaived: [] };
    case 'quarantine':
      return {
        continuity: 'not-applicable',
        assurance: 'degraded',
        claimsWaived: [],
      };
    case 'waive-assurance':
      return {
        continuity: 'preserved',
        assurance: 'human-waived',
        claimsWaived: ['reviewer-term-incorporation'],
      };
  }
}

function trustedPresentation(
  kind: SupportedInvestigationResolutionKind,
  supersedeReason: WorkflowSupersedeReason | null,
): TrustedChoicePresentation {
  switch (kind) {
    case 'resume-with-capability':
      return {
        title: 'Allow one additional reviewer-term reopen',
        consequences: [
          'Adds exactly one bounded reviewer-term reopen while preserving assurance.',
        ],
      };
    case 'close-input':
      return {
        title: 'Close reviewer input',
        consequences: [
          'Continues without further reviewer terms and degrades reviewer-term incorporation assurance.',
        ],
      };
    case 'abort':
      return {
        title: 'Abort investigation',
        consequences: [
          'Terminates this investigation and breaks workflow continuity.',
        ],
      };
    case 'quarantine':
      return {
        title: 'Quarantine unsafe investigation state',
        consequences: [
          'Removes the unsafe investigation from the active namespace without claiming repair.',
        ],
      };
    case 'supersede':
      return {
        title: `Supersede investigation — ${supersedeTitle(supersedeReason)}`,
        consequences: [
          'Terminates continuity for this investigation under the selected semantic replacement reason.',
        ],
      };
    case 'waive-assurance':
      return {
        title: 'Waive reviewer-term incorporation assurance',
        consequences: [
          'Continues the investigation with an explicit human waiver of reviewer-term incorporation assurance.',
        ],
      };
  }
}

function supersedeTitle(reason: WorkflowSupersedeReason | null): string {
  switch (reason) {
    case 'semantic-decision-no-continuing-value':
      return 'no continuing semantic value';
    case 'user-abandoned-goal-for-different-workflow':
      return 'goal moved to a different workflow';
    case 'workflow-replaced':
      return 'workflow replaced';
    case 'workflows-merged':
      return 'workflows merged';
    case null:
      throw investigationGrantInvalid(
        'INVESTIGATION_GRANT_PARAMETERS_INVALID',
        'Supersede presentation requires an exact reason.',
      );
  }
}

function reasonCodeFor(kind: SupportedInvestigationResolutionKind): string {
  switch (kind) {
    case 'resume-with-capability':
      return 'bounded-retry-approved';
    case 'close-input':
      return 'input-unavailable';
    case 'abort':
      return 'workflow-cannot-continue';
    case 'quarantine':
      return 'unsafe-state-isolation';
    case 'supersede':
      return 'workflow-replacement-approved';
    case 'waive-assurance':
      return 'assurance-waiver-approved';
  }
}

function transitionIdFor(kind: SupportedInvestigationResolutionKind): string {
  return `investigation.${kind}.v1`;
}

function isSupportedKind(
  kind: HumanResolutionDecision['kind'],
): kind is SupportedInvestigationResolutionKind {
  return SUPPORTED_KINDS.includes(kind as SupportedInvestigationResolutionKind);
}

function investigationStateBinding(
  repositoryHead: string,
  repositoryTree: string,
  resolutionStateDigest: string,
): StateBinding {
  return {
    kind: 'investigation-resolution-state',
    digest: sha256(
      canonicalJson({
        schema: 'investigation-grant-state-binding.v1',
        repositoryHead,
        repositoryTree,
        resolutionStateDigest,
      }),
    ),
  };
}

function investigationGrantInvalid(code: string, message: string) {
  return workflowError(code, message, ExitCode.guard);
}
