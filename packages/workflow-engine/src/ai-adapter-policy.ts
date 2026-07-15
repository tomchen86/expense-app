import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ExitCode, workflowError } from './errors.ts';

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

export type AiAdapterPolicy = {
  schemaVersion: 1;
  mode: 'evaluation-only';
  launchPolicy: 'deny';
  requiredControls: string[];
  approvedProviders: [];
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
    'approvedProviders',
    'launchPolicy',
    'mode',
    'requiredControls',
    'schemaVersion',
  ];
  const actualKeys = Object.keys(value).sort();
  return (
    JSON.stringify(actualKeys) === JSON.stringify(expectedKeys) &&
    value.schemaVersion === 1 &&
    value.mode === 'evaluation-only' &&
    value.launchPolicy === 'deny' &&
    Array.isArray(value.requiredControls) &&
    JSON.stringify(value.requiredControls) ===
      JSON.stringify(REQUIRED_AI_ADAPTER_CONTROLS) &&
    Array.isArray(value.approvedProviders) &&
    value.approvedProviders.length === 0
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
