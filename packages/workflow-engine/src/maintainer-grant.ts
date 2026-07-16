import fs from 'node:fs';
import path from 'node:path';

import { ExitCode, workflowError } from './errors.ts';
import { runGit } from './git.ts';
import {
  isAuthorityPathEligible,
  type MaintainerPolicy,
} from './maintainer-policy.ts';
import {
  assertChangeId,
  assertPolicyPathInsideRepository,
  normalizeExactRepositoryPath,
} from './paths.ts';

const COMMIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const GRANT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PAYLOAD_KEYS = [
  'version',
  'grantId',
  'repositoryId',
  'repositoryOrigin',
  'baseCommit',
  'policyBlob',
  'changeId',
  'allowedPaths',
  'issuedAt',
  'expiresAt',
  'maxUses',
  'reason',
  'signer',
];

export type MaintainerGrantPayload = {
  version: 1;
  grantId: string;
  repositoryId: string;
  repositoryOrigin: string;
  baseCommit: string;
  policyBlob: string;
  changeId: string;
  allowedPaths: string[];
  issuedAt: string;
  expiresAt: string;
  maxUses: 1;
  reason: string;
  signer: string;
};

export type GrantValidationOptions = {
  now: Date;
  expectedBase: string;
  expectedPolicyBlob: string;
  allowExpired?: boolean;
};

export function canonicalGrantPayload(payload: MaintainerGrantPayload): string {
  return `${JSON.stringify({
    version: payload.version,
    grantId: payload.grantId,
    repositoryId: payload.repositoryId,
    repositoryOrigin: payload.repositoryOrigin,
    baseCommit: payload.baseCommit,
    policyBlob: payload.policyBlob,
    changeId: payload.changeId,
    allowedPaths: payload.allowedPaths,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
    maxUses: payload.maxUses,
    reason: payload.reason,
    signer: payload.signer,
  })}\n`;
}

export function validateGrantPayload(
  payload: MaintainerGrantPayload,
  policy: MaintainerPolicy,
  options: GrantValidationOptions,
): void {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload) ||
    !hasExactKeys(
      payload as unknown as Record<string, unknown>,
      PAYLOAD_KEYS,
    ) ||
    payload.version !== 1 ||
    !GRANT_ID.test(payload.grantId) ||
    payload.repositoryId !== policy.repository.id ||
    payload.repositoryOrigin !== policy.repository.origin ||
    !COMMIT_OID.test(payload.baseCommit) ||
    payload.baseCommit !== options.expectedBase ||
    !COMMIT_OID.test(payload.policyBlob) ||
    payload.policyBlob !== options.expectedPolicyBlob ||
    payload.maxUses !== policy.maxUses ||
    !Array.isArray(payload.allowedPaths) ||
    payload.allowedPaths.length === 0 ||
    !validReason(payload.reason) ||
    !policy.trustedSigners.some(({ identity }) => identity === payload.signer)
  ) {
    throw invalidGrant('Maintainer grant does not match its trusted binding.');
  }

  try {
    assertChangeId(payload.changeId);
    const normalized = payload.allowedPaths.map(normalizeExactRepositoryPath);
    if (
      normalized.some(
        (value, index) => value !== payload.allowedPaths[index],
      ) ||
      !isSortedUnique(normalized) ||
      normalized.some((filePath) => !isAuthorityPathEligible(policy, filePath))
    ) {
      throw new Error('invalid paths');
    }
  } catch {
    throw invalidGrant('Maintainer grant contains invalid exact paths.');
  }

  const issuedAt = exactTimestamp(payload.issuedAt);
  const expiresAt = exactTimestamp(payload.expiresAt);
  const now = options.now.getTime();
  if (
    issuedAt === undefined ||
    expiresAt === undefined ||
    issuedAt > expiresAt ||
    expiresAt - issuedAt > policy.maxTtlMinutes * 60_000 ||
    issuedAt > now + 30_000
  ) {
    throw invalidGrant('Maintainer grant has invalid time bounds.');
  }
  if (!options.allowExpired && expiresAt < now) {
    throw workflowError(
      'MAINTAINER_GRANT_EXPIRED',
      'Maintainer grant has expired.',
      ExitCode.staleState,
    );
  }
}

export function assertGrantPathsEligible(
  repositoryRoot: string,
  requestedPaths: string[],
  policy: MaintainerPolicy,
): string[] {
  let paths: string[];
  try {
    paths = requestedPaths.map(normalizeExactRepositoryPath);
  } catch {
    throw invalidGrantPath();
  }
  if (paths.length === 0 || !isSortedUnique(paths)) {
    throw invalidGrantPath();
  }

  const tracked = runGit(repositoryRoot, ['ls-files', '--cached', '-z', '--'])
    .split('\0')
    .filter(Boolean);
  const caseFolded = new Map<string, string[]>();
  for (const trackedPath of tracked) {
    const key = trackedPath.toLocaleLowerCase('en-US');
    caseFolded.set(key, [...(caseFolded.get(key) ?? []), trackedPath]);
  }

  for (const filePath of paths) {
    const candidates =
      caseFolded.get(filePath.toLocaleLowerCase('en-US')) ?? [];
    const absolute = path.join(repositoryRoot, filePath);
    const stats = fs.lstatSync(absolute, { throwIfNoEntry: false });
    try {
      assertPolicyPathInsideRepository(repositoryRoot, filePath);
    } catch {
      throw invalidGrantPath(filePath);
    }
    if (
      candidates.length !== 1 ||
      candidates[0] !== filePath ||
      !stats?.isFile() ||
      stats.isSymbolicLink() ||
      fs.realpathSync(absolute) !==
        path.join(fs.realpathSync(repositoryRoot), filePath) ||
      !isAuthorityPathEligible(policy, filePath)
    ) {
      throw invalidGrantPath(filePath);
    }
  }
  return paths;
}

function exactTimestamp(value: string): number | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value
    ? time
    : undefined;
}

function validReason(value: string): boolean {
  return (
    typeof value === 'string' &&
    value.length >= 12 &&
    value.length <= 500 &&
    value.trim() === value &&
    ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || (code >= 127 && code <= 159);
    })
  );
}

function isSortedUnique(values: string[]): boolean {
  const sorted = [...new Set(values)].sort();
  return (
    values.length === sorted.length && values.every((v, i) => v === sorted[i])
  );
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((v, i) => v === expected[i])
  );
}

function invalidGrant(message: string) {
  return workflowError('MAINTAINER_GRANT_INVALID', message, ExitCode.guard);
}

function invalidGrantPath(filePath?: string) {
  return workflowError(
    'MAINTAINER_GRANT_PATH_INVALID',
    'Maintainer grant paths must be exact tracked eligible regular files.',
    ExitCode.guard,
    filePath ? { details: { path: filePath } } : {},
  );
}
