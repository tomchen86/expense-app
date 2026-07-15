import {
  loadAiAdapterPolicy,
  REQUIRED_AI_ADAPTER_CONTROLS,
} from './ai-adapter-policy.ts';

export type AiAdapterEvaluation = {
  schemaVersion: 1;
  mode: 'evaluation-only';
  decision: 'deny';
  launchAuthorized: false;
  filesystemSandboxVerified: false;
  sameUserProcessConfined: false;
  platform: NodeJS.Platform;
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
  return {
    schemaVersion: 1,
    mode: loaded.policy.mode,
    decision: 'deny',
    launchAuthorized: false,
    filesystemSandboxVerified: false,
    sameUserProcessConfined: false,
    platform,
    controls: REQUIRED_AI_ADAPTER_CONTROLS.map((id) => ({
      id,
      status: 'not-verified',
    })),
    reasons: [
      'NO_APPROVED_ISOLATION_PROVIDER',
      'SAME_USER_PROCESS_NOT_CONFINED',
      'ISOLATED_PATCH_IMPORT_NOT_IMPLEMENTED',
    ],
    futureExecutionModel: 'isolated-patch-import',
    policyDigest: loaded.digest,
  };
}
