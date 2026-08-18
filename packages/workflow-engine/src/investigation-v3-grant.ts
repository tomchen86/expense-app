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
import {
  INVESTIGATION_V3_ATTEMPTED_TRANSITIONS,
  type InvestigationV3Blocker,
  type InvestigationV3FailureCode,
} from './investigation-manifest.ts';

const RAW_DIGEST = /^[0-9a-f]{64}$/;
const FAILURE_CODE = /^[A-Z][A-Z0-9_]{0,255}$/;
const STOP_TRANSITION_ID = 'investigation.v3.stop-transition.v1';
const STOP_REASON_CODE = 'preserve-current-authority';

export type InvestigationV3GrantFacts = Readonly<{
  schemaVersion: 1;
  workflowKind: 'investigation-v3';
  blocker: InvestigationV3Blocker;
}>;

type InvestigationV3StopTransitionParameters = Readonly<{
  schemaVersion: 1;
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
    blocker: InvestigationV3Blocker;
    proposedReason: string;
  }>,
): GrantRequestInput<InvestigationV3GrantFacts> {
  const blocker = assertBlocker(input.blocker);
  const stateBinding = failureStateBinding(blocker);
  return freezeCanonical({
    sourceModuleId: 'investigation.v3',
    failureCode: investigationV3CentralFailureCode(blocker.failureCode),
    facts: {
      schemaVersion: 1,
      workflowKind: 'investigation-v3',
      blocker,
    },
    stateBinding,
    candidates: [
      {
        transitionId: STOP_TRANSITION_ID,
        parameters: {
          schemaVersion: 1,
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

export function investigationV3GrantTransitionDefinitions(): readonly TransitionDefinition<InvestigationV3StopTransitionParameters>[] {
  return [
    Object.freeze({
      transitionId: STOP_TRANSITION_ID,
      parameterSchemaDigest: sha256(
        canonicalJson({
          schema: 'investigation-v3-stop-transition-parameters.v1',
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
        return stopStateBinding(parameters);
      },
      async execute(context): Promise<TransitionOutcome> {
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

function assertBlocker(value: unknown): InvestigationV3Blocker {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'failureIdentity',
      'attemptedTransition',
      'candidateDigest',
      'failureCode',
      'detailsDigest',
      'missingAssuranceFacts',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'investigation-v3-failure' ||
    typeof value.failureIdentity !== 'string' ||
    !RAW_DIGEST.test(value.failureIdentity) ||
    !INVESTIGATION_V3_ATTEMPTED_TRANSITIONS.includes(
      value.attemptedTransition as InvestigationV3Blocker['attemptedTransition'],
    ) ||
    typeof value.candidateDigest !== 'string' ||
    !RAW_DIGEST.test(value.candidateDigest) ||
    typeof value.failureCode !== 'string' ||
    typeof value.detailsDigest !== 'string' ||
    !RAW_DIGEST.test(value.detailsDigest) ||
    !Array.isArray(value.missingAssuranceFacts) ||
    !value.missingAssuranceFacts.every(
      (fact) => typeof fact === 'string' && GRANT_STABLE_ID.test(fact),
    ) ||
    new Set(value.missingAssuranceFacts).size !==
      value.missingAssuranceFacts.length
  ) {
    throw investigationV3GrantInvalid(
      'INVESTIGATION_V3_GRANT_BLOCKER_INVALID',
      'Investigation v3 blocker is malformed.',
    );
  }
  investigationV3CentralFailureCode(value.failureCode);
  const identityInput = {
    attemptedTransition: value.attemptedTransition,
    candidateDigest: value.candidateDigest,
    failureCode: value.failureCode,
    detailsDigest: value.detailsDigest,
    missingAssuranceFacts: value.missingAssuranceFacts,
  };
  const expectedIdentity = sha256(
    canonicalJson({
      domain: 'investigation-v3-failure/v1',
      value: identityInput,
    }),
  ).slice('sha256:'.length);
  if (expectedIdentity !== value.failureIdentity) {
    throw investigationV3GrantInvalid(
      'INVESTIGATION_V3_GRANT_BLOCKER_INVALID',
      'Investigation v3 blocker identity does not match its facts.',
    );
  }
  return freezeCanonical(value) as InvestigationV3Blocker;
}

function failureStateBinding(blocker: InvestigationV3Blocker): StateBinding {
  return Object.freeze({
    kind: 'investigation.v3.failure',
    digest: sha256(
      canonicalJson({
        schema: 'investigation-v3-failure-state-binding.v1',
        blocker,
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
      'failureIdentity',
      'stateBindingDigest',
    ]) ||
    value.schemaVersion !== 1 ||
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

function stopStateBinding(
  parameters: InvestigationV3StopTransitionParameters,
): StateBinding {
  return Object.freeze({
    kind: 'investigation.v3.failure',
    digest: parameters.stateBindingDigest,
  });
}

function investigationV3GrantInvalid(code: string, message: string) {
  return workflowError(code, message, ExitCode.guard);
}
