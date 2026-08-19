import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { isProviderId, type ProviderId } from './provider-registry.ts';

/**
 * Actor resolution collects every recognized signal before selecting an actor.
 * Explicit `--actor` selection is self-declared. Recognized runtime hints
 * (`AGENT`, `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CODEX_SANDBOX`) are
 * runtime-hint assurance. Agreeing signals resolve to their shared provider;
 * contradictory signals fail closed with a conflict and no usable actor; a lack
 * of recognized evidence requires resolution. No local hint is ever promoted to
 * cryptographic identity.
 */
export type ActorAssurance =
  'self-declared' | 'runtime-hint' | 'adapter-assigned';

export type ActorSignal = {
  source: 'explicit' | 'runtime-hint';
  name: string;
  providerId: ProviderId;
  assurance: ActorAssurance;
};

export type ResolvedActor = {
  providerId: ProviderId;
  assurance: ActorAssurance;
};

export type ActorResolution =
  | {
      outcome: 'resolved';
      actor: ResolvedActor;
      signals: ActorSignal[];
    }
  | {
      outcome: 'actor-resolution-required';
      code: 'ACTOR_IDENTITY_REQUIRED' | 'ACTOR_IDENTITY_CONFLICT';
      signals: ActorSignal[];
    };

export type ActorResolutionInput = {
  explicitActor?: string;
  environment: Record<string, string | undefined>;
};

/**
 * A recognized runtime hint reads one environment variable and maps it to a
 * provider when present and meaningful. Empty, `0`, or unrecognized values are
 * not evidence and contribute no signal.
 */
const RUNTIME_HINTS: ReadonlyArray<{
  name: string;
  recognize(value: string): ProviderId | undefined;
}> = [
  {
    name: 'AGENT',
    recognize: (value) => (isProviderId(value) ? value : undefined),
  },
  {
    name: 'CLAUDECODE',
    recognize: (value) => (isTruthyFlag(value) ? 'claude' : undefined),
  },
  {
    name: 'CLAUDE_CODE_ENTRYPOINT',
    recognize: (value) => (value.length > 0 ? 'claude' : undefined),
  },
  {
    name: 'CODEX_SANDBOX',
    recognize: (value) => (value.length > 0 ? 'codex' : undefined),
  },
];

export function resolveActorIdentity(
  input: ActorResolutionInput,
): ActorResolution {
  const signals: ActorSignal[] = [];

  if (input.explicitActor !== undefined) {
    if (!isProviderId(input.explicitActor)) {
      throw workflowError(
        'ACTOR_PROVIDER_UNKNOWN',
        `Explicit actor "${input.explicitActor}" is not a registered provider.`,
        ExitCode.guard,
      );
    }
    signals.push({
      source: 'explicit',
      name: '--actor',
      providerId: input.explicitActor,
      assurance: 'self-declared',
    });
  }

  for (const hint of RUNTIME_HINTS) {
    const raw = input.environment[hint.name];
    if (typeof raw !== 'string') {
      continue;
    }
    const providerId = hint.recognize(raw);
    if (!providerId) {
      continue;
    }
    signals.push({
      source: 'runtime-hint',
      name: hint.name,
      providerId,
      assurance: 'runtime-hint',
    });
  }

  if (signals.length === 0) {
    return {
      outcome: 'actor-resolution-required',
      code: 'ACTOR_IDENTITY_REQUIRED',
      signals: [],
    };
  }

  const providers = new Set(signals.map((signal) => signal.providerId));
  if (providers.size > 1) {
    return {
      outcome: 'actor-resolution-required',
      code: 'ACTOR_IDENTITY_CONFLICT',
      signals,
    };
  }

  const [providerId] = providers;
  const assurance: ActorAssurance = signals.some(
    (signal) => signal.assurance === 'runtime-hint',
  )
    ? 'runtime-hint'
    : 'self-declared';
  return {
    outcome: 'resolved',
    actor: { providerId: providerId as ProviderId, assurance },
    signals,
  };
}

function isTruthyFlag(value: string): boolean {
  return value.length > 0 && value !== '0';
}
