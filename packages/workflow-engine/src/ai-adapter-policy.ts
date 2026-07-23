import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ExitCode, workflowError } from './errors.ts';
import { listBuiltInProviders, type ProviderId } from './provider-registry.ts';

export const REQUIRED_AI_ADAPTER_CONTROLS = [
  'separate-security-principal',
  'kernel-enforced-write-boundary',
  'git-common-directory-isolation',
  'network-egress-control',
  'secret-isolation',
  'subprocess-tree-confinement',
  'resource-limits',
  'immutable-runtime',
] as const;

/**
 * The code-owned positive maxima for the diagnostic adapter policy. Repository
 * policy may lower these but never raise them.
 */
export const MAX_AI_ADAPTER_LIMITS = Object.freeze({
  timeoutMs: 300_000,
  aggregateOutputBytes: 1_048_576,
  maxConcurrent: 2,
});

export type AiAdapterLimits = {
  timeoutMs: number;
  aggregateOutputBytes: number;
  maxConcurrent: number;
};

export type AiAdapterProviderPolicy = {
  enabled: boolean;
};

export type AiAdapterPolicy = {
  schemaVersion: 2;
  mode: 'evaluation-only';
  launchPolicy: 'deny';
  requiredControls: string[];
  providers: Record<ProviderId, AiAdapterProviderPolicy>;
  limits: AiAdapterLimits;
};

export type LoadedAiAdapterPolicy = {
  policy: AiAdapterPolicy;
  digest: string;
};

export function loadAiAdapterPolicy(
  repositoryRoot: string,
): LoadedAiAdapterPolicy {
  const content = readPlainPolicyFile(repositoryRoot);
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw invalidPolicy();
  }
  if (!isAiAdapterPolicy(value)) {
    throw invalidPolicy();
  }
  return {
    policy: value,
    digest: crypto.createHash('sha256').update(content).digest('hex'),
  };
}

function readPlainPolicyFile(repositoryRoot: string): string {
  const workflowDirectory = path.join(repositoryRoot, 'workflow');
  const policyPath = path.join(workflowDirectory, 'ai-adapter-policy.json');
  const directoryStats = fs.lstatSync(workflowDirectory, {
    throwIfNoEntry: false,
  });
  const policyStats = fs.lstatSync(policyPath, { throwIfNoEntry: false });
  if (
    !directoryStats?.isDirectory() ||
    directoryStats.isSymbolicLink() ||
    !policyStats?.isFile() ||
    policyStats.isSymbolicLink()
  ) {
    throw invalidPolicy();
  }

  const noFollow =
    process.platform !== 'win32' && typeof fs.constants.O_NOFOLLOW === 'number'
      ? fs.constants.O_NOFOLLOW
      : 0;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(policyPath, fs.constants.O_RDONLY | noFollow);
    if (!fs.fstatSync(descriptor).isFile()) {
      throw invalidPolicy();
    }
    return fs.readFileSync(descriptor, 'utf8');
  } catch (error) {
    if (isPolicyError(error)) {
      throw error;
    }
    throw invalidPolicy();
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}

function isAiAdapterPolicy(value: unknown): value is AiAdapterPolicy {
  if (!isRecord(value)) {
    return false;
  }
  const expectedKeys = [
    'launchPolicy',
    'limits',
    'mode',
    'providers',
    'requiredControls',
    'schemaVersion',
  ];
  const actualKeys = Object.keys(value).sort();
  return (
    JSON.stringify(actualKeys) === JSON.stringify(expectedKeys) &&
    value.schemaVersion === 2 &&
    value.mode === 'evaluation-only' &&
    value.launchPolicy === 'deny' &&
    Array.isArray(value.requiredControls) &&
    JSON.stringify(value.requiredControls) ===
      JSON.stringify(REQUIRED_AI_ADAPTER_CONTROLS) &&
    isProvidersPolicy(value.providers) &&
    isLimitsPolicy(value.limits)
  );
}

/**
 * Repository policy may only enable/disable the fixed built-in provider IDs. It
 * must supply exactly those IDs, each carrying only an `enabled` flag; any extra
 * ID, missing ID, or execution-authority field (command, path, module, prompt,
 * parser) fails closed.
 */
function isProvidersPolicy(
  value: unknown,
): value is Record<ProviderId, AiAdapterProviderPolicy> {
  if (!isRecord(value)) {
    return false;
  }
  const expectedIds = listBuiltInProviders()
    .map((provider) => provider.id)
    .sort();
  const actualIds = Object.keys(value).sort();
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
    return false;
  }
  return Object.values(value).every((entry) => {
    return (
      isRecord(entry) &&
      Object.keys(entry).length === 1 &&
      typeof entry.enabled === 'boolean'
    );
  });
}

/**
 * Repository policy may only lower the positive time/output/concurrency bounds.
 * Each limit must be a positive integer within the code-owned maxima.
 */
function isLimitsPolicy(value: unknown): value is AiAdapterLimits {
  if (!isRecord(value)) {
    return false;
  }
  const expectedKeys = ['aggregateOutputBytes', 'maxConcurrent', 'timeoutMs'];
  if (
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys)
  ) {
    return false;
  }
  return (
    isBoundedPositiveInteger(
      value.timeoutMs,
      MAX_AI_ADAPTER_LIMITS.timeoutMs,
    ) &&
    isBoundedPositiveInteger(
      value.aggregateOutputBytes,
      MAX_AI_ADAPTER_LIMITS.aggregateOutputBytes,
    ) &&
    isBoundedPositiveInteger(
      value.maxConcurrent,
      MAX_AI_ADAPTER_LIMITS.maxConcurrent,
    )
  );
}

function isBoundedPositiveInteger(value: unknown, maximum: number): boolean {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= maximum
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidPolicy() {
  return workflowError(
    'AI_ADAPTER_POLICY_INVALID',
    'AI adapter evaluation policy is missing, unsafe, or invalid.',
    ExitCode.guard,
  );
}

function isPolicyError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    error.code === 'AI_ADAPTER_POLICY_INVALID'
  );
}
