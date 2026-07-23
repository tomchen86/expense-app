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

export type AiAdapterProviderReport = {
  id: ProviderId;
  enabled: boolean;
  capabilities: Array<{
    purpose: CapabilityPurpose;
    profile: CapabilityProfile;
  }>;
  resolver: {
    status: 'not-implemented';
  };
};

/**
 * The diagnostic-only adapter evaluation. This slice performs no executable
 * resolution, provider preflight, or launch: it honestly reports the configured
 * providers and limits, an unimplemented resolver, an unauthorized launch, and
 * unverified controls/residuals on every platform.
 */
export type AiAdapterEvaluation = {
  schemaVersion: 2;
  mode: 'evaluation-only';
  decision: 'deny';
  launchAuthorized: false;
  filesystemSandboxVerified: false;
  sameUserProcessConfined: false;
  platform: NodeJS.Platform;
  limits: AiAdapterLimits;
  providers: AiAdapterProviderReport[];
  controls: Array<{ id: string; status: 'not-verified' }>;
  reasons: string[];
  futureExecutionModel: 'isolated-patch-import';
  policyDigest: string;
};

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
      resolver: { status: 'not-implemented' },
    }),
  );
  return {
    schemaVersion: 2,
    mode: loaded.policy.mode,
    decision: 'deny',
    launchAuthorized: false,
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
    reasons: [
      'PROVIDER_RESOLUTION_NOT_IMPLEMENTED',
      'SAME_USER_PROCESS_NOT_CONFINED',
      'ISOLATED_PATCH_IMPORT_NOT_IMPLEMENTED',
    ],
    futureExecutionModel: 'isolated-patch-import',
    policyDigest: loaded.digest,
  };
}
