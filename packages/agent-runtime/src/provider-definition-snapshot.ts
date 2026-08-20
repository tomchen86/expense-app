import crypto from 'node:crypto';
import path from 'node:path';

import { canonicalJson } from '@jigwright/core/canonical-json';

const DIGEST = /^[0-9a-f]{64}$/u;
const TOKEN = /^[a-z0-9](?:[a-z0-9._:/-]{0,126}[a-z0-9])?$/u;
const SNAPSHOT_KEYS = [
  'schemaVersion',
  'kind',
  'definitionId',
  'definitionRevision',
  'providerFamily',
  'trustTier',
  'enabled',
  'protocol',
  'platform',
  'executableCandidates',
  'commandProfile',
  'shell',
  'definitionDigest',
] as const;

export const PROVIDER_DEFINITION_SNAPSHOT_SCHEMA_VERSION = 1 as const;

export type ProviderDefinitionSnapshotInput = Readonly<{
  definitionId: string;
  definitionRevision: number;
  providerFamily: string;
  protocol: string;
  platform: string;
  executableCandidates: readonly string[];
  commandProfile: string;
}>;

/**
 * One normalized, immutable built-in provider definition. This data proves
 * which code-reviewed candidate set and command/protocol profile a launch used;
 * it does not itself grant repository data egress or executable authority.
 */
export type ProviderDefinitionSnapshot = Readonly<{
  schemaVersion: 1;
  kind: 'provider-definition-snapshot';
  definitionId: string;
  definitionRevision: number;
  providerFamily: string;
  trustTier: 'built-in-reviewed';
  enabled: true;
  protocol: string;
  platform: string;
  executableCandidates: readonly string[];
  commandProfile: string;
  shell: false;
  definitionDigest: string;
}>;

export class ProviderDefinitionSnapshotError extends TypeError {
  readonly code = 'PROVIDER_DEFINITION_SNAPSHOT_INVALID';

  constructor() {
    super('Provider definition snapshot is invalid.');
    this.name = 'ProviderDefinitionSnapshotError';
  }
}

export function createProviderDefinitionSnapshot(
  input: ProviderDefinitionSnapshotInput,
): ProviderDefinitionSnapshot {
  assertInput(input);
  const payload = {
    schemaVersion: PROVIDER_DEFINITION_SNAPSHOT_SCHEMA_VERSION,
    kind: 'provider-definition-snapshot' as const,
    definitionId: input.definitionId,
    definitionRevision: input.definitionRevision,
    providerFamily: input.providerFamily,
    trustTier: 'built-in-reviewed' as const,
    enabled: true as const,
    protocol: input.protocol,
    platform: input.platform,
    executableCandidates: [...input.executableCandidates],
    commandProfile: input.commandProfile,
    shell: false as const,
  };
  return deepFreeze({
    ...payload,
    definitionDigest: sha256(canonicalJson(payload)),
  });
}

export function assertProviderDefinitionSnapshot(
  value: unknown,
): ProviderDefinitionSnapshot {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, SNAPSHOT_KEYS) ||
    value.schemaVersion !== PROVIDER_DEFINITION_SNAPSHOT_SCHEMA_VERSION ||
    value.kind !== 'provider-definition-snapshot' ||
    value.trustTier !== 'built-in-reviewed' ||
    value.enabled !== true ||
    value.shell !== false ||
    typeof value.definitionDigest !== 'string' ||
    !DIGEST.test(value.definitionDigest)
  ) {
    throw new ProviderDefinitionSnapshotError();
  }
  const admitted = createProviderDefinitionSnapshot({
    definitionId: value.definitionId as string,
    definitionRevision: value.definitionRevision as number,
    providerFamily: value.providerFamily as string,
    protocol: value.protocol as string,
    platform: value.platform as string,
    executableCandidates: value.executableCandidates as string[],
    commandProfile: value.commandProfile as string,
  });
  if (admitted.definitionDigest !== value.definitionDigest) {
    throw new ProviderDefinitionSnapshotError();
  }
  return admitted;
}

function assertInput(input: ProviderDefinitionSnapshotInput): void {
  if (
    !isRecord(input) ||
    !isToken(input.definitionId) ||
    !Number.isSafeInteger(input.definitionRevision) ||
    input.definitionRevision < 1 ||
    !isToken(input.providerFamily) ||
    !isToken(input.protocol) ||
    !isToken(input.platform) ||
    !isToken(input.commandProfile) ||
    !Array.isArray(input.executableCandidates) ||
    input.executableCandidates.length === 0 ||
    input.executableCandidates.length > 16 ||
    new Set(input.executableCandidates).size !==
      input.executableCandidates.length ||
    input.executableCandidates.some(
      (candidate) =>
        typeof candidate !== 'string' ||
        candidate.length === 0 ||
        candidate.length > 4_096 ||
        candidate.includes('\0') ||
        !isAbsoluteForSnapshotPlatform(candidate, input.platform),
    )
  ) {
    throw new ProviderDefinitionSnapshotError();
  }
}

function isAbsoluteForSnapshotPlatform(
  candidate: string,
  platform: string,
): boolean {
  if (platform === 'win32') {
    return (
      path.win32.isAbsolute(candidate) &&
      (/^[a-z]:[\\/]/iu.test(candidate) ||
        /^\\\\[^\\/]+[\\/][^\\/]+/u.test(candidate) ||
        /^\/\/[^/]+\/[^/]+/u.test(candidate))
    );
  }
  return path.posix.isAbsolute(candidate);
}

function isToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return canonicalJson(actual) === canonicalJson(expected);
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
