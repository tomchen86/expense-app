import os from 'node:os';

import {
  loadAiAdapterPolicy,
  REQUIRED_AI_ADAPTER_CONTROLS,
  type AiAdapterLimits,
} from './ai-adapter-policy.ts';
import {
  listBuiltInProviders,
  type CapabilityProfile,
  type CapabilityPurpose,
  type ProviderId,
} from './provider-registry.ts';
import {
  preflightBuiltInProvider,
  PROVIDER_RUNNER_RESIDUALS,
  type ProviderResolution,
} from './provider-runner.ts';

export type AiAdapterProviderReport = {
  id: ProviderId;
  enabled: boolean;
  capabilities: Array<{
    purpose: CapabilityPurpose;
    profile: CapabilityProfile;
  }>;
  resolver: ProviderResolution;
};

/**
 * The managed-read-only adapter evaluation. It is a diagnostic that never
 * invokes a model: it reports the configured providers/limits, the honest
 * bounded resolver status of each provider (a version/help/auth preflight that
 * records the reviewed executable identity and version when present), unverified
 * isolation controls, an unauthorized launch, and the retained
 * same-user/observed-projection residuals on every platform. Real read-only
 * launch is reachable only through lifecycle orchestration, never this generic
 * pass-through.
 */
export type AiAdapterEvaluation = {
  schemaVersion: 3;
  mode: 'managed-read-only';
  decision: 'deny';
  launchAuthorized: false;
  lifecycleLaunchPolicy: 'lifecycle-only';
  filesystemSandboxVerified: false;
  sameUserProcessConfined: false;
  platform: NodeJS.Platform;
  limits: AiAdapterLimits;
  providers: AiAdapterProviderReport[];
  controls: Array<{ id: string; status: 'not-verified' }>;
  reasons: string[];
  residuals: string[];
  policyDigest: string;
};

const EVALUATION_REASONS = [
  'DIAGNOSTIC_COMMAND_DOES_NOT_LAUNCH',
  'SAME_USER_PROCESS_NOT_CONFINED',
  'OBSERVED_PROJECTION_EQUALITY_ONLY',
];

export function evaluateAiAdapter(
  repositoryRoot: string,
  platform: NodeJS.Platform = process.platform,
): AiAdapterEvaluation {
  const loaded = loadAiAdapterPolicy(repositoryRoot);
  const providers: AiAdapterProviderReport[] = listBuiltInProviders().map(
    (provider) => ({
      id: provider.id,
      enabled: loaded.policy.providers[provider.id].enabled,
      capabilities: provider.capabilities.map((capability) => ({
        purpose: capability.purpose,
        profile: capability.profile,
      })),
      resolver: preflightBuiltInProvider(provider.id, {
        platform,
        enabled: loaded.policy.providers[provider.id].enabled,
        sourceEnvironment: process.env,
        temporaryDirectory: os.tmpdir(),
      }),
    }),
  );
  return {
    schemaVersion: 3,
    mode: loaded.policy.mode,
    decision: 'deny',
    launchAuthorized: false,
    lifecycleLaunchPolicy: loaded.policy.launchPolicy,
    filesystemSandboxVerified: false,
    sameUserProcessConfined: false,
    platform,
    limits: {
      timeoutMs: loaded.policy.limits.timeoutMs,
      aggregateOutputBytes: loaded.policy.limits.aggregateOutputBytes,
      maxConcurrent: loaded.policy.limits.maxConcurrent,
    },
    providers,
    controls: REQUIRED_AI_ADAPTER_CONTROLS.map((id) => ({
      id,
      status: 'not-verified',
    })),
    reasons: [...EVALUATION_REASONS],
    residuals: [...PROVIDER_RUNNER_RESIDUALS],
    policyDigest: loaded.digest,
  };
}
