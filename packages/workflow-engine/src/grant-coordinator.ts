import { canonicalJson } from './canonical-json.ts';
import { isRecord } from './contract-values.ts';
import { ExitCode, workflowError } from './errors.ts';
import {
  evaluateApprovalProfile,
  type VerifiedApprovalProof,
} from './grant-approval.ts';
import {
  approvalSubjectDigest,
  createApprovalSubject,
  createGrantChallenge,
  type ApprovalSubject,
  type GrantApprovalMethod,
  type GrantChallenge,
  type GrantChallengeRef,
  type GrantRequestInput,
  type StateBinding,
} from './grant-core.ts';
import {
  approvalMethodsForPolicy,
  approvalProfileForMethod,
  type GrantPolicyV2,
} from './grant-policy.ts';
import {
  copyGrantDate,
  freezeGrantCanonical as freezeCanonical,
  GRANT_SHA256_DIGEST as SHA256_DIGEST,
  GRANT_UUID_V4 as UUID_V4,
  grantHasExactKeys as hasExactKeys,
} from './grant-primitives.ts';
import {
  persistGrantChallenge,
  prepareGrantTransition,
  readGrantRecord,
  recordGrantTransitionOutcome,
  type GrantStorePaths,
  type GrantAuditRecord,
  type PreparedGrantRecord,
  type TerminalGrantRecord,
} from './grant-store.ts';
import type {
  RegisteredTransitionDefinition,
  TransitionOutcome,
  TransitionRegistry,
} from './grant-transition-registry.ts';
import { GrantTransitionPreconditionError } from './grant-transition-registry.ts';

const DEFAULT_CHALLENGE_TTL_MS = 10 * 60_000;

export type TrustedGrantChoicePresentation = Readonly<{
  choiceId: `sha256:${string}`;
  transitionId: string;
  title: string;
  consequences: readonly string[];
  allowedReasonCodes: readonly string[];
  reasonRequired: boolean;
  proposedReason: string;
}>;

export type TrustedGrantPresentation = Readonly<{
  challenge: GrantChallenge;
  failureCode: string;
  facts: unknown;
  expiresAt: string;
  approvalMethods: readonly GrantApprovalMethod[];
  choices: readonly TrustedGrantChoicePresentation[];
}>;

export type GrantHumanDecision = Readonly<{
  choiceId: string;
  approvalMethod: GrantApprovalMethod;
  reasonCode: string;
  reason: string;
  sessionNonce: string;
}>;

export type GrantAuthenticationRequest = Readonly<{
  approvalSubject: ApprovalSubject;
  approvalSubjectDigest: `sha256:${string}`;
}>;

export type GrantApprovalSession = Readonly<{
  collectDecision(): Promise<GrantHumanDecision>;
  authenticate(
    request: GrantAuthenticationRequest,
  ): Promise<readonly VerifiedApprovalProof[]>;
  close(): Promise<void>;
}>;

export type GrantExecutionResult = Readonly<{
  challengeId: string;
  operationId: string;
  transitionId: string;
  outcome: 'completed' | 'failed';
  poststateDigest: `sha256:${string}`;
  recovered: boolean;
}>;

export type GrantCoordinator = Readonly<{
  requestGrant(input: GrantRequestInput): Promise<GrantChallengeRef>;
  inspectChallenge(challengeId: string): TrustedGrantPresentation;
  resolveChallenge(challengeId: string): Promise<GrantExecutionResult>;
  recoverChallenge(challengeId: string): Promise<GrantExecutionResult>;
}>;

type LifecycleOperation = <T>(
  challengeId: string,
  operation: (assertOwned: () => void) => Promise<T>,
) => Promise<T>;

/**
 * Testable Grant Core kernel. Production composition must bind this to the
 * code-owned Human Gate and repository lifecycle lock; no CLI or domain module
 * receives these dependencies.
 */
export function createGrantCoordinatorKernel(
  options: Readonly<{
    paths: GrantStorePaths;
    registry: TransitionRegistry;
    policy: GrantPolicyV2;
    now?: () => Date;
    randomUUID?: () => string;
    challengeTtlMs?: number;
    openApprovalSession(
      presentation: TrustedGrantPresentation,
    ): GrantApprovalSession | Promise<GrantApprovalSession>;
    withLifecycleOperation: LifecycleOperation;
  }>,
): GrantCoordinator {
  const now = options.now ?? (() => new Date());
  const randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
  const challengeTtlMs = options.challengeTtlMs ?? DEFAULT_CHALLENGE_TTL_MS;
  if (
    !Number.isInteger(challengeTtlMs) ||
    challengeTtlMs < 1 ||
    challengeTtlMs > 30 * 60_000
  ) {
    throw workflowError(
      'GRANT_COORDINATOR_INVALID',
      'Grant coordinator challenge bounds are invalid.',
      ExitCode.guard,
    );
  }

  return Object.freeze({
    async requestGrant(input) {
      const issuedAt = exactDate(now());
      const challenge = createGrantChallenge(input, options.registry, {
        challengeId: exactUuid(randomUUID()),
        now: issuedAt,
        expiresAt: new Date(issuedAt.getTime() + challengeTtlMs).toISOString(),
      });
      persistGrantChallenge(options.paths, challenge);
      return Object.freeze({
        challengeId: challenge.challengeId,
        challengeDigest: challenge.challengeDigest,
      });
    },

    inspectChallenge(challengeId) {
      const stored = readGrantRecord(options.paths, challengeId);
      return trustedPresentation(
        stored.challenge,
        options.registry,
        options.policy,
      );
    },

    async resolveChallenge(challengeId) {
      const stored = readGrantRecord(options.paths, challengeId);
      if (stored.state !== 'pending') throw challengeUnavailable(challengeId);
      const challenge = stored.challenge;
      const presentation = trustedPresentation(
        challenge,
        options.registry,
        options.policy,
      );
      const session = await options.openApprovalSession(presentation);
      let subject: ApprovalSubject;
      let subjectDigest: `sha256:${string}`;
      let proofs: readonly VerifiedApprovalProof[];
      try {
        const decision = assertHumanDecision(await session.collectDecision());
        subject = createApprovalSubject(challenge, decision, {
          now: exactDate(now()),
        });
        subjectDigest = approvalSubjectDigest(subject);
        proofs = await session.authenticate({
          approvalSubject: subject,
          approvalSubjectDigest: subjectDigest,
        });
      } finally {
        await session.close();
      }
      const evaluated = evaluateApprovalProfile(
        options.policy,
        approvalProfileForMethod(options.policy, subject.approvalMethod),
        subjectDigest,
        proofs,
      );

      return options.withLifecycleOperation(
        challengeId,
        async (assertOwned) => {
          assertOwned();
          const current = readGrantRecord(options.paths, challengeId);
          if (
            current.state !== 'pending' ||
            current.challenge.challengeDigest !== challenge.challengeDigest
          ) {
            throw challengeUnavailable(challengeId);
          }
          const selected = selectedTransition(
            challenge,
            subject,
            options.registry,
          );
          await assertExpectedState(
            selected.definition,
            selected.parameters,
            challenge.stateBinding,
          );
          assertOwned();
          const prepared = prepareGrantTransition(options.paths, {
            operationId: exactUuid(randomUUID()),
            challenge,
            subject,
            proofModules: evaluated.proofModules,
            createdAt: exactDate(now()).toISOString(),
          });
          assertOwned();
          return executePreparedTransition(
            options.paths,
            options.registry,
            challenge,
            prepared,
            assertOwned,
            now,
            false,
          );
        },
      );
    },

    async recoverChallenge(challengeId) {
      const observed = readGrantRecord(options.paths, challengeId);
      if (observed.state === 'pending') {
        throw workflowError(
          'GRANT_TRANSITION_RECORD_MISSING',
          'Grant transition recovery requires a prepared record.',
          ExitCode.staleState,
        );
      }
      if (observed.state === 'completed' || observed.state === 'failed') {
        return executionResult(observed, true);
      }
      return options.withLifecycleOperation(
        challengeId,
        async (assertOwned) => {
          assertOwned();
          const current = readGrantRecord(options.paths, challengeId);
          if (
            current.state === 'pending' ||
            current.operationId !== observed.operationId
          ) {
            throw workflowError(
              'GRANT_TRANSITION_RECOVERY_AMBIGUOUS',
              'Grant transition record changed during recovery.',
              ExitCode.staleState,
            );
          }
          if (current.state === 'completed' || current.state === 'failed') {
            return executionResult(current, true);
          }
          if (current.state !== 'prepared') {
            throw workflowError(
              'GRANT_TRANSITION_RECOVERY_AMBIGUOUS',
              'Grant transition record is not recoverable.',
              ExitCode.staleState,
            );
          }
          return executePreparedTransition(
            options.paths,
            options.registry,
            current.challenge,
            current,
            assertOwned,
            now,
            true,
          );
        },
      );
    },
  });
}

async function executePreparedTransition(
  paths: GrantStorePaths,
  registry: TransitionRegistry,
  challenge: GrantChallenge,
  record: PreparedGrantRecord,
  assertOwned: () => void,
  now: () => Date,
  recovered: boolean,
): Promise<GrantExecutionResult> {
  const selected = selectedTransition(
    challenge,
    record.approvalSubject,
    registry,
  );
  assertOwned();
  let outcome: TransitionOutcome;
  try {
    outcome = await selected.definition.execute({
      parameters: selected.parameters,
      approvalSubject: record.approvalSubject,
      approvalSubjectDigest: approvalSubjectDigest(record.approvalSubject),
      challengeId: challenge.challengeId,
      operationId: record.operationId,
      recovered,
      assertLifecycleOwned: assertOwned,
    });
  } catch (error) {
    if (!(error instanceof GrantTransitionPreconditionError)) {
      throw error;
    }
    assertOwned();
    const observed = assertStateBinding(
      await selected.definition.observeState(selected.parameters),
    );
    assertOwned();
    if (
      observed.kind === challenge.stateBinding.kind &&
      observed.digest === challenge.stateBinding.digest
    ) {
      throw error;
    }
    const failed = recordGrantTransitionOutcome(paths, {
      challengeId: challenge.challengeId,
      operationId: record.operationId,
      poststateDigest: observed.digest,
      outcome: {
        outcome: 'failed',
        details: {
          schemaVersion: 1,
          kind: 'grant-transition-state-drift.v1',
          failureCode: 'GRANT_STATE_CHANGED',
          transitionCompleted: false,
          transitionErrorCode: safeTransitionErrorCode(error.code),
          expectedStateBinding: challenge.stateBinding,
          observedStateBinding: observed,
        },
      },
      completedAt: exactDate(now()).toISOString(),
      audit: grantAudit(record),
    });
    return executionResult(failed, recovered);
  }
  assertOwned();
  const poststate = await selected.definition.observeState(selected.parameters);
  const normalizedPoststate = assertStateBinding(poststate);
  const completed = recordGrantTransitionOutcome(paths, {
    challengeId: challenge.challengeId,
    operationId: record.operationId,
    poststateDigest: normalizedPoststate.digest,
    outcome,
    completedAt: exactDate(now()).toISOString(),
    audit: grantAudit(record),
  });
  return executionResult(completed, recovered);
}

function safeTransitionErrorCode(value: string): string {
  return /^[A-Z][A-Z0-9_]{0,255}$/.test(value)
    ? value
    : 'UNCLASSIFIED_STALE_STATE';
}

function grantAudit(record: PreparedGrantRecord): GrantAuditRecord {
  const approvalMethod = record.approvalSubject.approvalMethod;
  const sshIdentity = record.proofModules.find(
    ({ claim }) => claim === 'ssh-signature',
  )?.identity;
  return freezeCanonical({
    approvalMethod,
    authorityClass:
      approvalMethod === 'human-presence'
        ? 'local-device-owner'
        : 'ssh-credential',
    identity:
      approvalMethod === 'human-presence' ? null : (sshIdentity ?? null),
    identityAssurance:
      approvalMethod === 'human-presence'
        ? 'not-asserted'
        : 'policy-trusted-ssh-key',
    presenceAssurance:
      approvalMethod === 'human-presence'
        ? 'fresh-os-authentication'
        : 'not-asserted',
    proofModules: record.proofModules.map(
      ({ moduleId, version }) => `${moduleId}@${version}`,
    ),
  });
}

function selectedTransition(
  challenge: GrantChallenge,
  subject: ApprovalSubject,
  registry: TransitionRegistry,
): Readonly<{
  choice: GrantChallenge['choices'][number];
  definition: RegisteredTransitionDefinition;
  parameters: unknown;
}> {
  const choice = challenge.choices.find(
    ({ choiceId }) => choiceId === subject.choiceId,
  );
  if (choice === undefined) throw challengeUnavailable(challenge.challengeId);
  registry.renderTrustedChoice(choice);
  const normalized = registry.normalizeParameters(
    choice.transitionId,
    choice.parameters,
  );
  if (
    canonicalJson(normalized.parameters) !== canonicalJson(choice.parameters) ||
    normalized.definition.parameterSchemaDigest !==
      choice.parameterSchemaDigest ||
    normalized.definition.consequenceDigest !== choice.consequenceDigest ||
    normalized.definition.resolutionKind !== choice.resolutionKind
  ) {
    throw workflowError(
      'GRANT_TRANSITION_DEFINITION_CHANGED',
      `Transition ${choice.transitionId} no longer matches the challenge.`,
      ExitCode.staleState,
    );
  }
  return {
    choice,
    definition: normalized.definition,
    parameters: normalized.parameters,
  };
}

async function assertExpectedState(
  definition: RegisteredTransitionDefinition,
  parameters: unknown,
  expected: StateBinding,
): Promise<void> {
  const observed = assertStateBinding(
    await definition.observeState(parameters),
  );
  if (observed.kind !== expected.kind || observed.digest !== expected.digest) {
    throw workflowError(
      'GRANT_STATE_CHANGED',
      'Protected state changed after the human decision; fresh approval is required.',
      ExitCode.staleState,
    );
  }
}

function trustedPresentation(
  challenge: GrantChallenge,
  registry: TransitionRegistry,
  policy: GrantPolicyV2,
): TrustedGrantPresentation {
  return freezeCanonical({
    challenge,
    failureCode: challenge.failureCode,
    facts: challenge.facts,
    expiresAt: challenge.expiresAt,
    approvalMethods: approvalMethodsForPolicy(policy),
    choices: challenge.choices.map((choice) => {
      const presentation = registry.renderTrustedChoice(choice);
      return {
        choiceId: choice.choiceId,
        transitionId: choice.transitionId,
        title: presentation.title,
        consequences: presentation.consequences,
        allowedReasonCodes: choice.allowedReasonCodes,
        reasonRequired: choice.reasonRequired,
        proposedReason: choice.proposedReason,
      };
    }),
  });
}

function assertHumanDecision(value: unknown): GrantHumanDecision {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'choiceId',
      'approvalMethod',
      'reasonCode',
      'reason',
      'sessionNonce',
    ]) ||
    typeof value.choiceId !== 'string' ||
    !SHA256_DIGEST.test(value.choiceId) ||
    !['human-presence', 'ssh'].includes(String(value.approvalMethod)) ||
    typeof value.reasonCode !== 'string' ||
    typeof value.reason !== 'string' ||
    typeof value.sessionNonce !== 'string'
  ) {
    throw workflowError(
      'GRANT_HUMAN_DECISION_INVALID',
      'Trusted Human Gate returned a malformed decision.',
      ExitCode.guard,
    );
  }
  return freezeCanonical(value) as unknown as GrantHumanDecision;
}

function assertStateBinding(value: unknown): StateBinding {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['kind', 'digest']) ||
    typeof value.kind !== 'string' ||
    !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(value.kind) ||
    typeof value.digest !== 'string' ||
    !SHA256_DIGEST.test(value.digest)
  ) {
    throw workflowError(
      'GRANT_STATE_BINDING_INVALID',
      'A registered transition returned an invalid state binding.',
      ExitCode.guard,
    );
  }
  return freezeCanonical(value) as unknown as StateBinding;
}

function executionResult(
  record: TerminalGrantRecord,
  recovered: boolean,
): GrantExecutionResult {
  const choice = record.challenge.choices.find(
    ({ choiceId }) => choiceId === record.approvalSubject.choiceId,
  );
  if (choice === undefined)
    throw challengeUnavailable(record.challenge.challengeId);
  return Object.freeze({
    challengeId: record.challenge.challengeId,
    operationId: record.operationId,
    transitionId: choice.transitionId,
    outcome: record.outcome.outcome,
    poststateDigest: record.poststateDigest,
    recovered,
  });
}

function exactUuid(value: string): string {
  if (!UUID_V4.test(value)) {
    throw workflowError(
      'GRANT_COORDINATOR_INVALID',
      'Grant coordinator generated an invalid identifier.',
      ExitCode.guard,
    );
  }
  return value;
}

function exactDate(value: Date): Date {
  const copy = copyGrantDate(value);
  if (copy === null) {
    throw workflowError(
      'GRANT_TIME_INVALID',
      'Grant coordinator time is invalid.',
      ExitCode.guard,
    );
  }
  return copy;
}

function challengeUnavailable(challengeId: string) {
  return workflowError(
    'GRANT_CHALLENGE_UNAVAILABLE',
    `Grant challenge ${challengeId} is not available.`,
    ExitCode.staleState,
  );
}
