import { canonicalJson } from './canonical-json.ts';
import { ExitCode, WorkflowError, workflowError } from './errors.ts';
import type {
  ApprovalSubject,
  GrantChoice,
  StateBinding,
} from './grant-core.ts';
import {
  freezeGrantCanonical,
  GRANT_SHA256_DIGEST as SHA256_DIGEST,
  GRANT_STABLE_ID as STABLE_ID,
} from './grant-primitives.ts';

export type TrustedChoicePresentation = Readonly<{
  title: string;
  consequences: readonly string[];
}>;

export type TransitionOutcome = Readonly<{
  outcome: 'completed' | 'failed';
  details: unknown;
}>;

export type AuthorizedTransitionContext<TParameters> = Readonly<{
  parameters: TParameters;
  approvalSubject: ApprovalSubject;
  approvalSubjectDigest: `sha256:${string}`;
  challengeId: string;
  operationId: string;
  recovered: boolean;
  assertLifecycleOwned(): void;
}>;

export class GrantTransitionPreconditionError extends WorkflowError {
  constructor(code: string, message: string) {
    super({ code, message, exitCode: ExitCode.staleState });
    this.name = 'GrantTransitionPreconditionError';
  }
}

export function grantTransitionPreconditionChanged(
  code: string,
  message: string,
): GrantTransitionPreconditionError {
  return new GrantTransitionPreconditionError(code, message);
}

export type TransitionDefinition<TParameters> = Readonly<{
  transitionId: string;
  parameterSchemaDigest: `sha256:${string}`;
  consequenceDigest: `sha256:${string}`;
  resolutionKind: 'retry' | 'non-retry';
  validateParameters(value: unknown): TParameters;
  renderTrustedChoice(parameters: TParameters): TrustedChoicePresentation;
  observeState(parameters: TParameters): StateBinding | Promise<StateBinding>;
  /** A GrantTransitionPreconditionError asserts no effect was applied. */
  execute(
    context: AuthorizedTransitionContext<TParameters>,
  ): Promise<TransitionOutcome>;
}>;

type TransitionRegistration = Readonly<{
  transitionId: string;
  parameterSchemaDigest: `sha256:${string}`;
  consequenceDigest: `sha256:${string}`;
  resolutionKind: 'retry' | 'non-retry';
  validateParameters(value: unknown): unknown;
  renderTrustedChoice(parameters: never): TrustedChoicePresentation;
  observeState(parameters: never): StateBinding | Promise<StateBinding>;
  execute(
    context: AuthorizedTransitionContext<never>,
  ): Promise<TransitionOutcome>;
}>;

export type RegisteredTransitionDefinition = Readonly<{
  transitionId: string;
  parameterSchemaDigest: `sha256:${string}`;
  consequenceDigest: `sha256:${string}`;
  resolutionKind: 'retry' | 'non-retry';
  validateParameters(value: unknown): unknown;
  renderTrustedChoice(parameters: unknown): TrustedChoicePresentation;
  observeState(parameters: unknown): StateBinding | Promise<StateBinding>;
  execute(
    context: AuthorizedTransitionContext<unknown>,
  ): Promise<TransitionOutcome>;
}>;

export type TransitionRegistry = Readonly<{
  resolve(transitionId: string): RegisteredTransitionDefinition;
  normalizeParameters(
    transitionId: string,
    parameters: unknown,
  ): Readonly<{
    definition: RegisteredTransitionDefinition;
    parameters: unknown;
  }>;
  renderTrustedChoice(choice: GrantChoice): TrustedChoicePresentation;
}>;

export function createTransitionRegistry(
  definitions: readonly TransitionRegistration[],
): TransitionRegistry {
  const registered = new Map<string, RegisteredTransitionDefinition>();
  for (const candidate of definitions) {
    assertDefinition(candidate);
    if (registered.has(candidate.transitionId)) {
      throw transitionInvalid(
        'GRANT_TRANSITION_DUPLICATE',
        `Transition ${candidate.transitionId} is registered more than once.`,
      );
    }
    registered.set(
      candidate.transitionId,
      Object.freeze({
        transitionId: candidate.transitionId,
        parameterSchemaDigest: candidate.parameterSchemaDigest,
        consequenceDigest: candidate.consequenceDigest,
        resolutionKind: candidate.resolutionKind,
        validateParameters: (value: unknown) =>
          candidate.validateParameters(value),
        renderTrustedChoice: (parameters: unknown) =>
          candidate.renderTrustedChoice(parameters as never),
        observeState: (parameters: unknown) =>
          candidate.observeState(parameters as never),
        execute: (context: AuthorizedTransitionContext<unknown>) =>
          candidate.execute(
            context as unknown as AuthorizedTransitionContext<never>,
          ),
      }),
    );
  }

  function resolve(transitionId: string): RegisteredTransitionDefinition {
    const definition = registered.get(transitionId);
    if (definition === undefined) {
      throw transitionInvalid(
        'GRANT_TRANSITION_UNKNOWN',
        `Transition ${transitionId} is not registered.`,
      );
    }
    return definition;
  }

  return Object.freeze({
    resolve,
    normalizeParameters(transitionId, parameters) {
      const definition = resolve(transitionId);
      let validated: unknown;
      try {
        validated = definition.validateParameters(cloneCanonical(parameters));
      } catch (error) {
        if (
          error instanceof Error &&
          'code' in error &&
          typeof error.code === 'string'
        ) {
          throw error;
        }
        throw transitionInvalid(
          'GRANT_TRANSITION_PARAMETERS_INVALID',
          `Parameters for transition ${transitionId} are invalid.`,
        );
      }
      return Object.freeze({
        definition,
        parameters: freezeGrantCanonical(validated),
      });
    },
    renderTrustedChoice(choice) {
      const definition = resolve(choice.transitionId);
      if (
        definition.parameterSchemaDigest !== choice.parameterSchemaDigest ||
        definition.consequenceDigest !== choice.consequenceDigest ||
        definition.resolutionKind !== choice.resolutionKind
      ) {
        throw transitionInvalid(
          'GRANT_TRANSITION_DEFINITION_CHANGED',
          `Transition ${choice.transitionId} no longer matches the challenge.`,
        );
      }
      const parameters = definition.validateParameters(
        cloneCanonical(choice.parameters),
      );
      return validatePresentation(
        definition.renderTrustedChoice(parameters),
        choice.transitionId,
      );
    },
  });
}

function assertDefinition(value: TransitionRegistration): void {
  if (
    value === null ||
    typeof value !== 'object' ||
    !STABLE_ID.test(value.transitionId) ||
    !SHA256_DIGEST.test(value.parameterSchemaDigest) ||
    !SHA256_DIGEST.test(value.consequenceDigest) ||
    !['retry', 'non-retry'].includes(value.resolutionKind) ||
    typeof value.validateParameters !== 'function' ||
    typeof value.renderTrustedChoice !== 'function' ||
    typeof value.observeState !== 'function' ||
    typeof value.execute !== 'function'
  ) {
    throw transitionInvalid(
      'GRANT_TRANSITION_DEFINITION_INVALID',
      'A code-owned transition definition is malformed.',
    );
  }
}

function validatePresentation(
  value: TrustedChoicePresentation,
  transitionId: string,
): TrustedChoicePresentation {
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof value.title !== 'string' ||
    value.title.trim() !== value.title ||
    value.title.length < 1 ||
    value.title.length > 160 ||
    !Array.isArray(value.consequences) ||
    value.consequences.length < 1 ||
    !value.consequences.every(
      (entry) =>
        typeof entry === 'string' &&
        entry.trim() === entry &&
        entry.length >= 1 &&
        entry.length <= 512,
    )
  ) {
    throw transitionInvalid(
      'GRANT_TRANSITION_PRESENTATION_INVALID',
      `Trusted presentation for transition ${transitionId} is invalid.`,
    );
  }
  return freezeGrantCanonical(value) as TrustedChoicePresentation;
}

function cloneCanonical<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function transitionInvalid(code: string, message: string) {
  return workflowError(code, message, ExitCode.guard);
}
