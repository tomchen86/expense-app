import { canonicalJson } from './canonical-json.ts';
import { isRecord } from './contract-values.ts';
import { ExitCode, workflowError } from './errors.ts';
import type { GrantRequestInput, StateBinding } from './grant-core.ts';
import {
  freezeGrantCanonical as freezeCanonical,
  GRANT_STABLE_ID,
  grantHasExactKeys as hasExactKeys,
  grantSha256 as sha256,
} from './grant-primitives.ts';
import type {
  TransitionDefinition,
  TransitionOutcome,
} from './grant-transition-registry.ts';
import { loadInvestigationRuntimeContext } from './lifecycle-context.ts';
import {
  parseInvestigationV3Blocker,
  type InvestigationV3Blocker,
  type InvestigationV3FailureCode,
} from './investigation-manifest.ts';
import { readInvestigationV3ShadowFailureObservation } from './investigation-shadow-store.ts';
import { assertChangeId, assertInvestigationId } from './paths.ts';

const RAW_DIGEST = /^[0-9a-f]{64}$/;
const FAILURE_CODE = /^[A-Z][A-Z0-9_]{0,255}$/;
const STOP_TRANSITION_ID = 'investigation.v3.stop-transition.v2';
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

type InvestigationV3StopTransitionParameters = Readonly<{
  schemaVersion: 2;
  repositoryId: string;
  changeId: string;
  investigationId: string;
  sessionRevision: number;
  sessionSnapshotDigest: string;
  failureIdentity: string;
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
  const { blocker } = failure;
  const stateBinding = failureStateBinding(failure);
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
          schemaVersion: 2,
          repositoryId: failure.repositoryId,
          changeId: failure.changeId,
          investigationId: failure.investigationId,
          sessionRevision: failure.sessionRevision,
          sessionSnapshotDigest: failure.sessionSnapshotDigest,
          failureIdentity: blocker.failureIdentity,
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
): readonly TransitionDefinition<InvestigationV3StopTransitionParameters>[] {
  return [
    Object.freeze({
      transitionId: STOP_TRANSITION_ID,
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
      validateParameters: assertStopParameters,
      renderTrustedChoice() {
        return {
          title: 'Stop this Investigation v3 transition',
          consequences: [
            'Preserves the failed assurance and keeps the current authority unchanged.',
          ],
        };
      },
      observeState(parameters) {
        return observeFailureState(cwd, parameters);
      },
      async execute(context): Promise<TransitionOutcome> {
        context.assertLifecycleOwned();
        const observed = observeFailureState(cwd, context.parameters);
        if (observed.digest !== context.parameters.stateBindingDigest) {
          throw workflowError(
            'INVESTIGATION_V3_GRANT_STATE_CHANGED',
            'Investigation v3 failure state changed before the central transition could complete.',
            ExitCode.staleState,
          );
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
  ];
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

function failureStateBinding(
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

function assertStopParameters(
  value: unknown,
): InvestigationV3StopTransitionParameters {
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
  return freezeCanonical(value) as InvestigationV3StopTransitionParameters;
}

function observeFailureState(
  cwd: string,
  parameters: InvestigationV3StopTransitionParameters,
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
  return failureStateBinding({
    repositoryId: observation.repositoryId,
    changeId: observation.changeId,
    investigationId: observation.investigationId,
    sessionRevision: observation.sessionRevision,
    sessionSnapshotDigest: observation.sessionSnapshotDigest,
    blocker: observation.result.blocker,
  });
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
