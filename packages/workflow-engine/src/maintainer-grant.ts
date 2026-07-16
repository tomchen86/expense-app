import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ExitCode, workflowError } from './errors.ts';
import { discoverRepository, runGit, runGitWithEnvironment } from './git.ts';
import {
  isAuthorityPathEligible,
  parseMaintainerPolicy,
  type MaintainerPolicy,
} from './maintainer-policy.ts';
import {
  createInteractiveSshSigner,
  type MaintainerSignerProvider,
} from './maintainer-signer.ts';
import {
  maintainerGrantStorePaths,
  storeAvailableMaintainerGrant,
} from './maintainer-store.ts';
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

export type MaintainerGrantEnvelope = {
  payload: MaintainerGrantPayload;
  signature: string;
};

export type MaintainerGrantRequest = {
  changeId: string;
  paths: string[];
  reason: string;
  ttlMinutes?: number;
  maxUses?: number;
};

export type MaintainerGrantIssueOptions = {
  now?: Date;
  grantId?: string;
  signer?: MaintainerSignerProvider;
};

export type MaintainerGrantIssueResult = {
  grantId: string;
  tagRef: string;
  publishCommand: string;
  availableTokenPath: string;
  envelope: MaintainerGrantEnvelope;
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

export function canonicalGrantEnvelope(
  envelope: MaintainerGrantEnvelope,
): string {
  const canonicalPayload = JSON.parse(
    canonicalGrantPayload(envelope.payload),
  ) as MaintainerGrantPayload;
  return `${JSON.stringify({
    payload: canonicalPayload,
    signature: envelope.signature,
  })}\n`;
}

export function assertMaintainerGrantId(requestedGrantId: string): string {
  if (
    typeof requestedGrantId !== 'string' ||
    !GRANT_ID.test(requestedGrantId)
  ) {
    throw invalidGrant('Maintainer grant ID is invalid.');
  }
  return requestedGrantId;
}

export function parseMaintainerGrantEnvelope(
  raw: string,
): MaintainerGrantEnvelope {
  try {
    if (typeof raw !== 'string' || raw.length > 32_768) {
      throw new Error('invalid envelope size');
    }
    const value = JSON.parse(raw) as unknown;
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      !hasExactKeys(value as Record<string, unknown>, ['payload', 'signature'])
    ) {
      throw new Error('invalid envelope');
    }
    const candidate = value as Record<string, unknown>;
    if (
      typeof candidate.payload !== 'object' ||
      candidate.payload === null ||
      Array.isArray(candidate.payload) ||
      !hasExactKeys(
        candidate.payload as Record<string, unknown>,
        PAYLOAD_KEYS,
      ) ||
      typeof candidate.signature !== 'string'
    ) {
      throw new Error('invalid envelope fields');
    }
    const envelope = {
      payload: candidate.payload as MaintainerGrantPayload,
      signature: candidate.signature,
    };
    assertArmoredSshSignature(envelope.signature);
    assertMaintainerGrantId(envelope.payload.grantId);
    if (canonicalGrantEnvelope(envelope) !== raw) {
      throw new Error('non-canonical envelope');
    }
    return envelope;
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'MAINTAINER_SIGNATURE_INVALID'
    ) {
      throw error;
    }
    throw invalidGrant('Maintainer grant envelope is invalid.');
  }
}

export function issueMaintainerGrant(
  cwd: string,
  request: MaintainerGrantRequest,
  options: MaintainerGrantIssueOptions = {},
): MaintainerGrantIssueResult {
  const repository = discoverRepository(cwd);
  if (repository.statusEntries.length > 0) {
    throw workflowError(
      'MAINTAINER_GRANT_DIRTY_WORKTREE',
      'Maintainer grants can be issued only from a clean worktree.',
      ExitCode.conflict,
    );
  }

  const policy = loadBasePolicy(repository.repositoryRoot, repository.head);
  const origin = runGit(repository.repositoryRoot, [
    'remote',
    'get-url',
    'origin',
  ]).trim();
  if (origin !== policy.repository.origin) {
    throw workflowError(
      'MAINTAINER_REPOSITORY_MISMATCH',
      'The repository origin does not match the trusted maintainer policy.',
      ExitCode.guard,
    );
  }

  const requestedPaths = normalizeRequestedPaths(request.paths);
  const allowedPaths = assertGrantPathsEligible(
    repository.repositoryRoot,
    requestedPaths,
    policy,
  );
  const ttlMinutes = request.ttlMinutes ?? policy.maxTtlMinutes;
  const maxUses = request.maxUses ?? policy.maxUses;
  if (
    !Number.isInteger(ttlMinutes) ||
    ttlMinutes < 1 ||
    ttlMinutes > policy.maxTtlMinutes ||
    maxUses !== 1
  ) {
    throw invalidGrant('Maintainer grant bounds exceed trusted policy.');
  }

  const now = options.now ? new Date(options.now) : new Date();
  if (!Number.isFinite(now.getTime())) {
    throw invalidGrant('Maintainer grant issue time is invalid.');
  }
  const grantId = options.grantId ?? crypto.randomUUID();
  if (!GRANT_ID.test(grantId)) {
    throw invalidGrant('Maintainer grant ID is invalid.');
  }
  const tagRef = `${policy.auditTagPrefix}${grantId}`;
  const storePaths = maintainerGrantStorePaths(repository.gitCommonDirectory);
  const availableTokenPath = path.join(storePaths.available, `${grantId}.json`);
  if (
    fs.existsSync(availableTokenPath) ||
    runGit(
      repository.repositoryRoot,
      ['rev-parse', '--verify', tagRef],
      true,
    ).trim()
  ) {
    throw grantExists(grantId);
  }

  const signer =
    options.signer ??
    createInteractiveSshSigner(repository.repositoryRoot, policy);
  signer.assertHumanPresent();
  const signerIdentity = signer.identity();
  const policyBlob = runGit(repository.repositoryRoot, [
    'rev-parse',
    `${repository.head}:workflow/maintainer-policy.json`,
  ]).trim();
  const payload: MaintainerGrantPayload = {
    version: 1,
    grantId,
    repositoryId: policy.repository.id,
    repositoryOrigin: policy.repository.origin,
    baseCommit: repository.head,
    policyBlob,
    changeId: request.changeId,
    allowedPaths,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMinutes * 60_000).toISOString(),
    maxUses: 1,
    reason: request.reason,
    signer: signerIdentity,
  };
  validateGrantPayload(payload, policy, {
    now,
    expectedBase: repository.head,
    expectedPolicyBlob: policyBlob,
  });

  const canonicalPayload = canonicalGrantPayload(payload);
  const signature = signer.sign(canonicalPayload);
  assertArmoredSshSignature(signature);
  signer.verify(canonicalPayload, signature, signerIdentity);
  const envelope = { payload, signature };
  const canonicalEnvelope = canonicalGrantEnvelope(envelope);

  const tagObject = createAuditTag(
    repository.repositoryRoot,
    repository.head,
    tagRef,
    canonicalEnvelope,
    signerIdentity,
  );
  try {
    storeAvailableMaintainerGrant(repository.gitCommonDirectory, envelope);
  } catch (error) {
    runGit(repository.repositoryRoot, ['update-ref', '-d', tagRef, tagObject]);
    throw error;
  }

  return {
    grantId,
    tagRef,
    publishCommand: `git push origin ${tagRef}:${tagRef}`,
    availableTokenPath,
    envelope,
  };
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

function loadBasePolicy(
  repositoryRoot: string,
  baseCommit: string,
): MaintainerPolicy {
  try {
    return parseMaintainerPolicy(
      JSON.parse(
        runGit(repositoryRoot, [
          'show',
          `${baseCommit}:workflow/maintainer-policy.json`,
        ]),
      ),
    );
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) {
      throw error;
    }
    throw workflowError(
      'MAINTAINER_POLICY_INVALID',
      'The base commit does not contain a valid maintainer policy.',
      ExitCode.guard,
    );
  }
}

function normalizeRequestedPaths(requestedPaths: string[]): string[] {
  if (!Array.isArray(requestedPaths)) {
    throw invalidGrantPath();
  }
  let normalized: string[];
  try {
    normalized = requestedPaths.map(normalizeExactRepositoryPath).sort();
  } catch {
    throw invalidGrantPath();
  }
  if (normalized.length !== new Set(normalized).size) {
    throw invalidGrantPath();
  }
  return normalized;
}

function assertArmoredSshSignature(signature: string): void {
  if (
    typeof signature !== 'string' ||
    signature.length > 16_384 ||
    signature.includes('\r') ||
    !/^-----BEGIN SSH SIGNATURE-----\n(?:[A-Za-z0-9+/=]+\n)+-----END SSH SIGNATURE-----\n$/.test(
      signature,
    )
  ) {
    throw workflowError(
      'MAINTAINER_SIGNATURE_INVALID',
      'The maintainer grant SSH signature is invalid.',
      ExitCode.verification,
    );
  }
}

function createAuditTag(
  repositoryRoot: string,
  baseCommit: string,
  tagRef: string,
  message: string,
  signerIdentity: string,
): string {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-grant-tag-'),
  );
  fs.chmodSync(temporaryDirectory, 0o700);
  const messagePath = path.join(temporaryDirectory, 'message');
  try {
    fs.writeFileSync(messagePath, message, { encoding: 'utf8', mode: 0o600 });
    const shortName = tagRef.slice('refs/tags/'.length);
    runGitWithEnvironment(
      repositoryRoot,
      [
        'tag',
        '--annotate',
        '--cleanup=verbatim',
        '--file',
        messagePath,
        shortName,
        baseCommit,
      ],
      {
        GIT_COMMITTER_NAME: signerIdentity,
        GIT_COMMITTER_EMAIL: 'workflow-maintainer@users.noreply.github.com',
      },
    );
    return runGit(repositoryRoot, ['rev-parse', `${tagRef}^{tag}`]).trim();
  } catch (error) {
    if (
      runGit(repositoryRoot, ['rev-parse', '--verify', tagRef], true).trim()
    ) {
      throw grantExists(tagRef.slice(policyTagPrefixLength(tagRef)));
    }
    throw error;
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function policyTagPrefixLength(tagRef: string): number {
  return tagRef.lastIndexOf('/') + 1;
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

function grantExists(grantId: string) {
  return workflowError(
    'MAINTAINER_GRANT_EXISTS',
    `Maintainer grant ${grantId} already has local state or an audit tag.`,
    ExitCode.conflict,
  );
}

function invalidGrantPath(filePath?: string) {
  return workflowError(
    'MAINTAINER_GRANT_PATH_INVALID',
    'Maintainer grant paths must be exact tracked eligible regular files.',
    ExitCode.guard,
    filePath ? { details: { path: filePath } } : {},
  );
}
