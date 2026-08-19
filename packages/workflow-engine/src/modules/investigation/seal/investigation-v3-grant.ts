import { canonicalJson } from '../../../foundation/canonical-json/canonical-json.ts';
import { isRecord } from '../../../foundation/canonical-json/contract-values.ts';
import { ExitCode, workflowError } from '../../../foundation/errors/errors.ts';
import type {
  GrantRequestInput,
  StateBinding,
} from '../../authority/grant-core.ts';
import {
  freezeGrantCanonical as freezeCanonical,
  GRANT_STABLE_ID,
  grantHasExactKeys as hasExactKeys,
  grantSha256 as sha256,
} from '../../authority/grant-primitives.ts';
import type {
  TransitionDefinition,
  TransitionOutcome,
} from '../../authority/grant-transition-registry.ts';
import { grantTransitionPreconditionChanged } from '../../authority/grant-transition-registry.ts';
import {
  assertInvestigationManifestPublicationFailure,
  assertInvestigationV3FailureSource,
  initialInvestigationV3FailureSourceObservation,
  investigationV3PublicationFailureSource,
  investigationV3ShadowFailureSource,
  observeInvestigationV3FailureSource,
  type InvestigationV3FailureSource,
  type InvestigationV3ObservedFailureSource,
} from './investigation-v3-failure-source.ts';
import { loadInvestigationRuntimeContext } from '../../../composition-root/lifecycle-context.ts';
import {
  parseInvestigationV3Blocker,
  type InvestigationV3Blocker,
  type InvestigationV3FailureCode,
} from '../manifest/investigation-manifest.ts';
import {
  investigationManifestPublicationFailureEmissionDigest,
  type InvestigationManifestPublicationFailure,
} from '../../../runtime/managed-documents/transaction/investigation-publication.ts';
import { readInvestigationV3ShadowFailureObservation } from '../../../runtime/storage-journal/investigation-shadow-store.ts';
import {
  assertChangeId,
  assertInvestigationId,
} from '../../../runtime/session-workspace/paths.ts';

const RAW_DIGEST = /^[0-9a-f]{64}$/;
const FAILURE_CODE = /^[A-Z][A-Z0-9_]{0,255}$/;
const LEGACY_STOP_TRANSITION_ID = 'investigation.v3.stop-transition.v2';
const STOP_TRANSITION_ID = 'investigation.v3.stop-transition.v3';
const STOP_REASON_CODE = 'preserve-current-authority';

export type InvestigationV3GrantFacts = Readonly<{
  schemaVersion: 1;
  workflowKind: 'investigation-v3';
  repositoryId: string;
  changeId: string;
  investigationId: string;
  sessionRevision: number;
  sessionSnapshotDigest: string;
  blocker: InvestigationV3Blocker;
}>;

export type InvestigationV3GrantFailureContext = Readonly<{
  repositoryId: string;
  changeId: string;
  investigationId: string;
  sessionRevision: number;
  sessionSnapshotDigest: string;
  blocker: InvestigationV3Blocker;
}>;

type InvestigationV3StopTransitionParametersV2 = Readonly<{
  schemaVersion: 2;
  repositoryId: string;
  changeId: string;
  investigationId: string;
  sessionRevision: number;
  sessionSnapshotDigest: string;
  failureIdentity: string;
  stateBindingDigest: `sha256:${string}`;
}>;

type InvestigationV3StopTransitionParametersV3 = Readonly<{
  schemaVersion: 3;
  repositoryId: string;
  changeId: string;
  investigationId: string;
  sessionRevision: number;
  sessionSnapshotDigest: string;
  blocker: InvestigationV3Blocker;
  source: InvestigationV3FailureSource;
  stateBindingDigest: `sha256:${string}`;
}>;

/**
 * Central Grant producer adapter for the complete v3 blocker contract. The
 * mapping is deliberately algorithmic so a future failure code does not fall
 * outside Grant Core merely because a diagnostic catalog was not extended.
 */
export function createInvestigationV3GrantRequest(
  input: Readonly<{
    failure: InvestigationV3GrantFailureContext;
    proposedReason: string;
  }>,
): GrantRequestInput<InvestigationV3GrantFacts> {
  const failure = assertFailureContext(input.failure);
  const source = investigationV3ShadowFailureSource();
  return createSourceBoundGrantRequest({
    failure,
    source,
    observation: initialInvestigationV3FailureSourceObservation({
      cwd: null,
      identity: failure,
      source,
    }),
    proposedReason: input.proposedReason,
  });
}

export function createInvestigationV3PublicationGrantRequest(
  input: Readonly<{
    cwd: string;
    failure: InvestigationManifestPublicationFailure;
    proposedReason: string;
  }>,
): GrantRequestInput<InvestigationV3GrantFacts> {
  const emitted = assertInvestigationManifestPublicationFailure(input.failure);
  const failure = assertFailureContext({
    ...emitted.lifecycle,
    blocker: emitted.blocker,
  });
  if (failure.blocker.attemptedTransition !== 'publication') {
    throw investigationV3GrantInvalid(
      'INVESTIGATION_V3_GRANT_SOURCE_MISMATCH',
      'A publication source may bind only a publication blocker.',
    );
  }
  const source = investigationV3PublicationFailureSource(emitted);
  const observation = initialInvestigationV3FailureSourceObservation({
    cwd: input.cwd,
    identity: failure,
    source,
  });
  if (
    emitted.source.recoveryPolicy === 'idempotent-post-ref' &&
    (observation.publicationRecoveryKind === 'post-ref' ||
      observation.publicationRecoveryKind === 'committed')
  ) {
    throw investigationV3GrantInvalid(
      'INVESTIGATION_V3_GRANT_NOT_REQUIRED',
      'The publication can complete by idempotent post-ref recovery without a human Grant.',
    );
  }
  return createSourceBoundGrantRequest({
    failure,
    source,
    observation,
    proposedReason: input.proposedReason,
  });
}

function createSourceBoundGrantRequest(
  input: Readonly<{
    failure: InvestigationV3GrantFailureContext;
    source: InvestigationV3FailureSource;
    observation: InvestigationV3ObservedFailureSource;
    proposedReason: string;
  }>,
): GrantRequestInput<InvestigationV3GrantFacts> {
  const { failure, source, observation } = input;
  const { blocker } = failure;
  const stateBinding = sourceFailureStateBinding(observation, source);
  return freezeCanonical({
    sourceModuleId: 'investigation.v3',
    failureCode: investigationV3CentralFailureCode(blocker.failureCode),
    facts: {
      schemaVersion: 1,
      workflowKind: 'investigation-v3',
      repositoryId: failure.repositoryId,
      changeId: failure.changeId,
      investigationId: failure.investigationId,
      sessionRevision: failure.sessionRevision,
      sessionSnapshotDigest: failure.sessionSnapshotDigest,
      blocker,
    },
    stateBinding,
    candidates: [
      {
        transitionId: STOP_TRANSITION_ID,
        parameters: {
          schemaVersion: 3,
          repositoryId: failure.repositoryId,
          changeId: failure.changeId,
          investigationId: failure.investigationId,
          sessionRevision: failure.sessionRevision,
          sessionSnapshotDigest: failure.sessionSnapshotDigest,
          blocker,
          source,
          stateBindingDigest: stateBinding.digest,
        },
        allowedReasonCodes: [STOP_REASON_CODE],
        reasonRequired: true,
        proposedReason: input.proposedReason,
      },
    ],
  });
}

export function investigationV3CentralFailureCode(
  failureCode: InvestigationV3FailureCode,
): string {
  if (
    typeof failureCode !== 'string' ||
    failureCode.trim() !== failureCode ||
    failureCode.length < 1 ||
    Buffer.byteLength(failureCode) > 256 ||
    /[\0\r\n]/.test(failureCode)
  ) {
    throw investigationV3GrantInvalid(
      'INVESTIGATION_V3_GRANT_FAILURE_CODE_INVALID',
      'Investigation v3 failure code is malformed.',
    );
  }
  if (FAILURE_CODE.test(failureCode)) {
    const normalized = failureCode.toLowerCase().replaceAll('_', '-');
    const mapped = `investigation.v3.${normalized}`;
    if (GRANT_STABLE_ID.test(mapped)) return mapped;
  }
  const suffix = sha256(failureCode).slice('sha256:'.length, 23);
  return `investigation.v3.unclassified-${suffix}`;
}

export function investigationV3GrantTransitionDefinitions(
  cwd: string,
): readonly [
  TransitionDefinition<InvestigationV3StopTransitionParametersV2>,
  TransitionDefinition<InvestigationV3StopTransitionParametersV3>,
] {
  return [
    Object.freeze({
      transitionId: LEGACY_STOP_TRANSITION_ID,
      parameterSchemaDigest: sha256(
        canonicalJson({
          schema: 'investigation-v3-stop-transition-parameters.v2',
        }),
      ),
      consequenceDigest: sha256(
        canonicalJson({
          schema: 'investigation-v3-stop-transition-consequences.v1',
          rendererVersion: 1,
        }),
      ),
      resolutionKind: 'non-retry' as const,
      validateParameters: assertStopParametersV2,
      renderTrustedChoice: renderStopChoice,
      observeState(parameters) {
        return observeLegacyFailureState(cwd, parameters);
      },
      async execute(context): Promise<TransitionOutcome> {
        context.assertLifecycleOwned();
        const observed = observeLegacyFailureState(cwd, context.parameters);
        if (observed.digest !== context.parameters.stateBindingDigest) {
          throw stateChanged();
        }
        context.assertLifecycleOwned();
        return {
          outcome: 'completed',
          details: {
            continuation: 'stop-transition',
            failureIdentity: context.parameters.failureIdentity,
            failurePreserved: true,
            authorityAdvanced: false,
          },
        };
      },
    }),
    Object.freeze({
      transitionId: STOP_TRANSITION_ID,
      parameterSchemaDigest: sha256(
        canonicalJson({
          schema: 'investigation-v3-stop-transition-parameters.v3',
        }),
      ),
      consequenceDigest: sha256(canonicalJson(renderStopChoice())),
      resolutionKind: 'non-retry' as const,
      validateParameters: assertStopParametersV3,
      renderTrustedChoice: renderStopChoice,
      observeState(parameters) {
        return observeSourceBoundFailureState(cwd, parameters);
      },
      async execute(context): Promise<TransitionOutcome> {
        context.assertLifecycleOwned();
        const observed = observeSourceBoundFailureState(
          cwd,
          context.parameters,
        );
        if (observed.digest !== context.parameters.stateBindingDigest) {
          throw stateChanged();
        }
        context.assertLifecycleOwned();
        return {
          outcome: 'completed',
          details: {
            continuation: 'stop-transition',
            failureIdentity: context.parameters.blocker.failureIdentity,
            failurePreserved: true,
            authorityAdvanced: false,
          },
        };
      },
    }),
  ];
}

function renderStopChoice() {
  return {
    title: 'Stop this Investigation v3 transition',
    consequences: [
      'Preserves the failed assurance and keeps the current authority unchanged.',
    ],
  };
}

function assertFailureContext(
  value: unknown,
): InvestigationV3GrantFailureContext {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'repositoryId',
      'changeId',
      'investigationId',
      'sessionRevision',
      'sessionSnapshotDigest',
      'blocker',
    ]) ||
    !validRepositoryId(value.repositoryId) ||
    !validChangeId(value.changeId) ||
    !validInvestigationId(value.investigationId) ||
    typeof value.sessionRevision !== 'number' ||
    !Number.isSafeInteger(value.sessionRevision) ||
    value.sessionRevision < 0 ||
    typeof value.sessionSnapshotDigest !== 'string' ||
    !RAW_DIGEST.test(value.sessionSnapshotDigest)
  ) {
    throw investigationV3GrantInvalid(
      'INVESTIGATION_V3_GRANT_CONTEXT_INVALID',
      'Investigation v3 failure context is malformed.',
    );
  }
  let blocker: InvestigationV3Blocker;
  try {
    blocker = parseInvestigationV3Blocker(value.blocker);
    investigationV3CentralFailureCode(blocker.failureCode);
  } catch {
    throw investigationV3GrantInvalid(
      'INVESTIGATION_V3_GRANT_BLOCKER_INVALID',
      'Investigation v3 blocker is malformed.',
    );
  }
  return freezeCanonical({
    repositoryId: value.repositoryId,
    changeId: value.changeId,
    investigationId: value.investigationId,
    sessionRevision: value.sessionRevision,
    sessionSnapshotDigest: value.sessionSnapshotDigest,
    blocker,
  });
}

function legacyFailureStateBinding(
  failure: InvestigationV3GrantFailureContext,
): StateBinding {
  return Object.freeze({
    kind: 'investigation.v3.failure',
    digest: sha256(
      canonicalJson({
        schema: 'investigation-v3-failure-state-binding.v1',
        repositoryId: failure.repositoryId,
        changeId: failure.changeId,
        investigationId: failure.investigationId,
        sessionRevision: failure.sessionRevision,
        sessionSnapshotDigest: failure.sessionSnapshotDigest,
        blocker: failure.blocker,
      }),
    ),
  });
}

function sourceFailureStateBinding(
  observation: InvestigationV3ObservedFailureSource,
  source: InvestigationV3FailureSource,
): StateBinding {
  return Object.freeze({
    kind: 'investigation.v3.failure',
    digest: sha256(
      canonicalJson({
        schema: 'investigation-v3-failure-state-binding.v2',
        repositoryId: observation.identity.repositoryId,
        changeId: observation.identity.changeId,
        investigationId: observation.identity.investigationId,
        sessionRevision: observation.identity.sessionRevision,
        sessionSnapshotDigest: observation.identity.sessionSnapshotDigest,
        blocker: observation.identity.blocker,
        observerId: source.observerId,
        sourceStateDigest: observation.sourceStateDigest,
      }),
    ),
  });
}

function assertStopParametersV2(
  value: unknown,
): InvestigationV3StopTransitionParametersV2 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'repositoryId',
      'changeId',
      'investigationId',
      'sessionRevision',
      'sessionSnapshotDigest',
      'failureIdentity',
      'stateBindingDigest',
    ]) ||
    value.schemaVersion !== 2 ||
    !validRepositoryId(value.repositoryId) ||
    !validChangeId(value.changeId) ||
    !validInvestigationId(value.investigationId) ||
    typeof value.sessionRevision !== 'number' ||
    !Number.isSafeInteger(value.sessionRevision) ||
    value.sessionRevision < 0 ||
    typeof value.sessionSnapshotDigest !== 'string' ||
    !RAW_DIGEST.test(value.sessionSnapshotDigest) ||
    typeof value.failureIdentity !== 'string' ||
    !RAW_DIGEST.test(value.failureIdentity) ||
    typeof value.stateBindingDigest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(value.stateBindingDigest)
  ) {
    throw investigationV3GrantInvalid(
      'INVESTIGATION_V3_GRANT_PARAMETERS_INVALID',
      'Investigation v3 transition parameters are malformed.',
    );
  }
  return freezeCanonical(value) as InvestigationV3StopTransitionParametersV2;
}

function assertStopParametersV3(
  value: unknown,
): InvestigationV3StopTransitionParametersV3 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'repositoryId',
      'changeId',
      'investigationId',
      'sessionRevision',
      'sessionSnapshotDigest',
      'blocker',
      'source',
      'stateBindingDigest',
    ]) ||
    value.schemaVersion !== 3 ||
    !validRepositoryId(value.repositoryId) ||
    !validChangeId(value.changeId) ||
    !validInvestigationId(value.investigationId) ||
    typeof value.sessionRevision !== 'number' ||
    !Number.isSafeInteger(value.sessionRevision) ||
    value.sessionRevision < 0 ||
    typeof value.sessionSnapshotDigest !== 'string' ||
    !RAW_DIGEST.test(value.sessionSnapshotDigest) ||
    typeof value.stateBindingDigest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(value.stateBindingDigest)
  ) {
    throw investigationV3GrantInvalid(
      'INVESTIGATION_V3_GRANT_PARAMETERS_INVALID',
      'Investigation v3 transition parameters are malformed.',
    );
  }
  let blocker: InvestigationV3Blocker;
  let source: InvestigationV3FailureSource;
  try {
    blocker = parseInvestigationV3Blocker(value.blocker);
    source = assertInvestigationV3FailureSource(value.source);
  } catch {
    throw investigationV3GrantInvalid(
      'INVESTIGATION_V3_GRANT_PARAMETERS_INVALID',
      'Investigation v3 transition blocker or source is malformed.',
    );
  }
  if (
    source.observerId === 'investigation-v3.publication-state.v1' &&
    (blocker.attemptedTransition !== 'publication' ||
      source.source.failureIdentity !== blocker.failureIdentity ||
      investigationManifestPublicationFailureEmissionDigest({
        schemaVersion: 1,
        kind: 'investigation-manifest-publication-failure',
        lifecycle: {
          repositoryId: value.repositoryId,
          changeId: value.changeId,
          investigationId: value.investigationId,
          sessionRevision: value.sessionRevision,
          sessionSnapshotDigest: value.sessionSnapshotDigest,
        },
        blocker,
        source: {
          schemaVersion: source.source.schemaVersion,
          observation: source.source.observation,
          failureIdentity: source.source.failureIdentity,
          emittedPublicationStateDigest:
            source.source.emittedPublicationStateDigest,
          emittedGitStateDigest: source.source.emittedGitStateDigest,
          recoveryPolicy: source.source.recoveryPolicy,
        },
      }) !== source.source.emissionDigest)
  ) {
    throw investigationV3GrantInvalid(
      'INVESTIGATION_V3_GRANT_SOURCE_MISMATCH',
      'Investigation v3 publication source does not match its blocker.',
    );
  }
  return freezeCanonical({
    schemaVersion: 3 as const,
    repositoryId: value.repositoryId,
    changeId: value.changeId,
    investigationId: value.investigationId,
    sessionRevision: value.sessionRevision,
    sessionSnapshotDigest: value.sessionSnapshotDigest,
    blocker,
    source,
    stateBindingDigest: value.stateBindingDigest as `sha256:${string}`,
  });
}

function observeLegacyFailureState(
  cwd: string,
  parameters: InvestigationV3StopTransitionParametersV2,
): StateBinding {
  const context = loadInvestigationRuntimeContext(cwd);
  if (context.config.repositoryName !== parameters.repositoryId) {
    throw investigationV3GrantInvalid(
      'INVESTIGATION_V3_GRANT_REPOSITORY_MISMATCH',
      'Investigation v3 Grant transition observed another repository.',
    );
  }
  const observation = readInvestigationV3ShadowFailureObservation(
    context.runtime,
    parameters.investigationId,
  );
  return legacyFailureStateBinding({
    repositoryId: observation.repositoryId,
    changeId: observation.changeId,
    investigationId: observation.investigationId,
    sessionRevision: observation.sessionRevision,
    sessionSnapshotDigest: observation.sessionSnapshotDigest,
    blocker: observation.result.blocker,
  });
}

function observeSourceBoundFailureState(
  cwd: string,
  parameters: InvestigationV3StopTransitionParametersV3,
): StateBinding {
  const context = loadInvestigationRuntimeContext(cwd);
  if (context.config.repositoryName !== parameters.repositoryId) {
    throw investigationV3GrantInvalid(
      'INVESTIGATION_V3_GRANT_REPOSITORY_MISMATCH',
      'Investigation v3 Grant transition observed another repository.',
    );
  }
  const observation = observeInvestigationV3FailureSource({
    cwd,
    expectedIdentity: {
      repositoryId: parameters.repositoryId,
      changeId: parameters.changeId,
      investigationId: parameters.investigationId,
      sessionRevision: parameters.sessionRevision,
      sessionSnapshotDigest: parameters.sessionSnapshotDigest,
      blocker: parameters.blocker,
    },
    source: parameters.source,
  });
  return sourceFailureStateBinding(observation, parameters.source);
}

function stateChanged() {
  return grantTransitionPreconditionChanged(
    'INVESTIGATION_V3_GRANT_STATE_CHANGED',
    'Investigation v3 failure state changed before the central transition could complete.',
  );
}

function validRepositoryId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim() === value &&
    value.length > 0 &&
    Buffer.byteLength(value) <= 256 &&
    !/[\0\r\n]/.test(value)
  );
}

function validChangeId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return assertChangeId(value) === value;
  } catch {
    return false;
  }
}

function validInvestigationId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return assertInvestigationId(value) === value;
  } catch {
    return false;
  }
}

function investigationV3GrantInvalid(code: string, message: string) {
  return workflowError(code, message, ExitCode.guard);
}
