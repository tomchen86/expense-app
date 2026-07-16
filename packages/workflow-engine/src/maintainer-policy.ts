import fs from 'node:fs';
import path from 'node:path';

import { isRecord, isStringArray } from './contract-values.ts';
import { ExitCode, workflowError } from './errors.ts';
import { matchesAllowedPath, normalizePolicyPath } from './paths.ts';

const CHECK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SIGNER_ID = /^[a-zA-Z0-9][a-zA-Z0-9._@+-]{0,127}$/;
const SSH_PUBLIC_KEY =
  /^ssh-(?:ed25519|ed25519-sk|rsa|ecdsa-[^ ]+) [A-Za-z0-9+/]+={0,2}$/;
const SSH_FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{20,}$/;
const POLICY_KEYS = [
  'schemaVersion',
  'repository',
  'phase',
  'auditTagPrefix',
  'signatureNamespace',
  'maxTtlMinutes',
  'maxUses',
  'bootstrapEligiblePaths',
  'sealedImmutablePaths',
  'requiredChecks',
  'trustedSigners',
];

export type TrustedMaintainerSigner = {
  identity: string;
  publicKey: string;
  fingerprint: string;
};

export type MaintainerPolicy = {
  schemaVersion: 1;
  repository: { id: string; origin: string };
  phase: 'bootstrap' | 'sealed';
  auditTagPrefix: string;
  signatureNamespace: string;
  maxTtlMinutes: 30;
  maxUses: 1;
  bootstrapEligiblePaths: string[];
  sealedImmutablePaths: string[];
  requiredChecks: string[];
  trustedSigners: TrustedMaintainerSigner[];
};

export function loadMaintainerPolicy(repositoryRoot: string): MaintainerPolicy {
  const policyPath = path.join(
    repositoryRoot,
    'workflow/maintainer-policy.json',
  );
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  } catch (error) {
    throw invalidPolicy('Unable to read workflow/maintainer-policy.json.', {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  return parseMaintainerPolicy(value);
}

export function parseMaintainerPolicy(value: unknown): MaintainerPolicy {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, POLICY_KEYS) ||
    value.schemaVersion !== 1 ||
    !isRecord(value.repository) ||
    !hasExactKeys(value.repository, ['id', 'origin']) ||
    typeof value.repository.id !== 'string' ||
    !/^github:[A-Za-z0-9_-]+$/.test(value.repository.id) ||
    typeof value.repository.origin !== 'string' ||
    !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(
      value.repository.origin,
    ) ||
    (value.phase !== 'bootstrap' && value.phase !== 'sealed') ||
    typeof value.auditTagPrefix !== 'string' ||
    !/^refs\/tags\/[a-z0-9][a-z0-9-]*\/$/.test(value.auditTagPrefix) ||
    value.signatureNamespace !== 'expense-app.workflow.maintainer-grant.v1' ||
    value.maxTtlMinutes !== 30 ||
    value.maxUses !== 1 ||
    !isStringArray(value.bootstrapEligiblePaths) ||
    !isStringArray(value.sealedImmutablePaths) ||
    !isStringArray(value.requiredChecks) ||
    !Array.isArray(value.trustedSigners) ||
    value.trustedSigners.length === 0
  ) {
    throw invalidPolicy('Maintainer policy does not match schema version 1.');
  }

  const bootstrapEligiblePaths = value.bootstrapEligiblePaths;
  const sealedImmutablePaths = value.sealedImmutablePaths;
  const requiredChecks = value.requiredChecks;

  assertSortedUnique(bootstrapEligiblePaths, 'bootstrap paths');
  assertSortedUnique(sealedImmutablePaths, 'sealed paths');
  assertSortedUnique(requiredChecks, 'required checks');

  try {
    bootstrapEligiblePaths.forEach(normalizePolicyPath);
    sealedImmutablePaths.forEach(normalizePolicyPath);
  } catch {
    throw invalidPolicy(
      'Maintainer policy contains an invalid authority path.',
    );
  }
  if (
    requiredChecks.length === 0 ||
    requiredChecks.some((checkId) => !CHECK_ID.test(checkId))
  ) {
    throw invalidPolicy('Maintainer policy contains invalid required checks.');
  }
  if (
    sealedImmutablePaths.some(
      (immutablePath) =>
        !bootstrapEligiblePaths.some((eligiblePath) =>
          matchesAllowedPath(immutablePath, eligiblePath),
        ),
    )
  ) {
    throw invalidPolicy(
      'Every sealed immutable path must be bootstrap-eligible.',
    );
  }

  const signers = value.trustedSigners.map(parseSigner);
  assertSortedUnique(
    signers.map(({ identity }) => identity),
    'trusted signer identities',
  );
  if (
    new Set(signers.map(({ publicKey }) => publicKey)).size !==
      signers.length ||
    new Set(signers.map(({ fingerprint }) => fingerprint)).size !==
      signers.length
  ) {
    throw invalidPolicy('Trusted maintainer signer keys must be unique.');
  }

  return {
    schemaVersion: 1,
    repository: {
      id: value.repository.id,
      origin: value.repository.origin,
    },
    phase: value.phase,
    auditTagPrefix: value.auditTagPrefix,
    signatureNamespace: value.signatureNamespace,
    maxTtlMinutes: 30,
    maxUses: 1,
    bootstrapEligiblePaths: [...bootstrapEligiblePaths],
    sealedImmutablePaths: [...sealedImmutablePaths],
    requiredChecks: [...requiredChecks],
    trustedSigners: signers,
  };
}

export function isAuthorityPathEligible(
  policy: MaintainerPolicy,
  filePath: string,
): boolean {
  return (
    policy.bootstrapEligiblePaths.some((eligible) =>
      matchesAllowedPath(filePath, eligible),
    ) &&
    (policy.phase !== 'sealed' ||
      !policy.sealedImmutablePaths.some((immutable) =>
        matchesAllowedPath(filePath, immutable),
      ))
  );
}

function parseSigner(value: unknown): TrustedMaintainerSigner {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['identity', 'publicKey', 'fingerprint']) ||
    typeof value.identity !== 'string' ||
    !SIGNER_ID.test(value.identity) ||
    typeof value.publicKey !== 'string' ||
    !SSH_PUBLIC_KEY.test(value.publicKey) ||
    typeof value.fingerprint !== 'string' ||
    !SSH_FINGERPRINT.test(value.fingerprint)
  ) {
    throw invalidPolicy(
      'Maintainer policy contains an invalid trusted signer.',
    );
  }
  return {
    identity: value.identity,
    publicKey: value.publicKey,
    fingerprint: value.fingerprint,
  };
}

function assertSortedUnique(values: string[], label: string): void {
  const sorted = [...new Set(values)].sort();
  if (
    values.length !== sorted.length ||
    values.some((v, i) => v !== sorted[i])
  ) {
    throw invalidPolicy(
      `Maintainer policy ${label} must be sorted and unique.`,
    );
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function invalidPolicy(message: string, details?: Record<string, unknown>) {
  return workflowError(
    'MAINTAINER_POLICY_INVALID',
    message,
    ExitCode.guard,
    details ? { details } : {},
  );
}
