import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';

/**
 * The reviewed built-in provider registry. It is code-owned: repository policy
 * may enable/disable these fixed IDs and lower bounded limits, but it can never
 * add an ID, executable path, argv, shell fragment, module path, prompt, or
 * result parser. This slice exposes exactly `codex` and `claude`, each with the
 * `survey`, `plan-review`, `task-diff-review`, and `task-implementation`
 * capabilities under the
 * `repository-read-only` profile.
 */
export type ProviderId = 'codex' | 'claude';
export type CapabilityPurpose =
  'survey' | 'plan-review' | 'task-diff-review' | 'task-implementation';
export type CapabilityProfile = 'repository-read-only';

export type ProviderCapability = {
  readonly purpose: CapabilityPurpose;
  readonly profile: CapabilityProfile;
};

export type BuiltInProvider = {
  readonly id: ProviderId;
  readonly capabilities: readonly ProviderCapability[];
};

function readOnlyCapabilities(): readonly ProviderCapability[] {
  return [
    Object.freeze({ purpose: 'survey', profile: 'repository-read-only' }),
    Object.freeze({ purpose: 'plan-review', profile: 'repository-read-only' }),
    Object.freeze({
      purpose: 'task-implementation',
      profile: 'repository-read-only',
    }),
    Object.freeze({
      purpose: 'task-diff-review',
      profile: 'repository-read-only',
    }),
  ];
}

const BUILT_IN_PROVIDERS: readonly BuiltInProvider[] = Object.freeze(
  (['codex', 'claude'] as const).map((id) =>
    Object.freeze({
      id,
      capabilities: Object.freeze(readOnlyCapabilities()),
    }),
  ),
);

/**
 * Return the deeply frozen built-in provider registry. The same immutable
 * value is returned on every call, so no caller can mutate the shared registry.
 */
export function listBuiltInProviders(): readonly BuiltInProvider[] {
  return BUILT_IN_PROVIDERS;
}

/**
 * Resolve a built-in provider that supports the requested capability under the
 * requested profile. Throws `PROVIDER_UNKNOWN` for an unregistered ID and
 * `PROVIDER_CAPABILITY_UNSUPPORTED` when the provider does not declare the
 * requested purpose/profile pair.
 */
export function requireProviderCapability(
  id: ProviderId,
  purpose: CapabilityPurpose,
  profile: CapabilityProfile,
): BuiltInProvider {
  const provider = BUILT_IN_PROVIDERS.find((entry) => entry.id === id);
  if (!provider) {
    throw workflowError(
      'PROVIDER_UNKNOWN',
      `Provider "${id}" is not in the reviewed built-in registry.`,
      ExitCode.guard,
    );
  }
  const capable = provider.capabilities.some(
    (capability) =>
      capability.purpose === purpose && capability.profile === profile,
  );
  if (!capable) {
    throw workflowError(
      'PROVIDER_CAPABILITY_UNSUPPORTED',
      `Provider "${id}" does not support ${purpose} under ${profile}.`,
      ExitCode.guard,
    );
  }
  return provider;
}

export function isProviderId(value: unknown): value is ProviderId {
  return value === 'codex' || value === 'claude';
}
