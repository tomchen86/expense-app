import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from './canonical-json.ts';
import { isRecord, isStringArray } from './contract-values.ts';
import { ExitCode, workflowError } from './errors.ts';
import { listChangedPaths, runGit } from './git.ts';
import { matchesAllowedPath, normalizeExactRepositoryPath } from './paths.ts';

/**
 * Maintainer grant v2 binds authority to an exact patch rather than to a path
 * allowlist: every changed file carries a verified trust role, its exact
 * before/after identity, and its Git mode. A file is admissible because it
 * appears in this signed manifest with the correct role for the profile — not
 * because a glob in repository policy happens to cover it.
 */

const MANIFEST_SCHEMA = 'maintainer-patch-manifest.v2';
const PROFILE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const GIT_MODES = new Set(['100644', '100755']);

export type FileRole =
  | 'implementation'
  | 'evidence'
  | 'policy'
  | 'verification-infrastructure'
  | 'forbidden';

export type PatchOperation = 'add' | 'modify' | 'delete';

export type CapabilityProfileConstraints = {
  evidenceOnlyGrantForbidden: boolean;
  samePackageRequired: boolean;
  evidenceAdditionsAllowed: boolean;
  maximumFiles: number;
};

export type CapabilityProfile = {
  id: string;
  version: number;
  implementationPaths: string[];
  evidencePaths: string[];
  policyPaths: string[];
  verificationInfrastructurePaths: string[];
  forbiddenPaths: string[];
  constraints: CapabilityProfileConstraints;
  requiredChecks: string[];
};

export type PatchManifestFile = {
  path: string;
  role: Exclude<FileRole, 'forbidden'>;
  operation: PatchOperation;
  beforeBlobOid: string | null;
  afterSha256: string | null;
  beforeMode: string | null;
  afterMode: string | null;
};

export type PatchManifest = {
  schema: typeof MANIFEST_SCHEMA;
  profile: string;
  profileVersion: number;
  trustBaseCommit: string;
  policyDigest: string;
  files: PatchManifestFile[];
  patchDigest: string;
};

export type PatchManifestRequest = {
  profile: CapabilityProfile;
  trustBaseCommit: string;
  policyDigest: string;
};

/**
 * Profiles are part of the trust base: they are read from the pinned commit,
 * never from the working tree, so a candidate patch can neither invent nor
 * relax the profile that judges it.
 */
export function loadCapabilityProfileFromTrustBase(
  repositoryRoot: string,
  trustBaseCommit: string,
  profileId: string,
): CapabilityProfile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      runGit(repositoryRoot, [
        'show',
        `${trustBaseCommit}:workflow/maintainer-profiles.json`,
      ]),
    );
  } catch {
    throw profileInvalid(
      'The trust base does not contain a valid workflow/maintainer-profiles.json.',
    );
  }
  if (
    !isRecord(parsed) ||
    parsed.schemaVersion !== 1 ||
    !isRecord(parsed.profiles)
  ) {
    throw profileInvalid('Maintainer profiles file is malformed.');
  }
  const raw = parsed.profiles[profileId];
  if (raw === undefined) {
    throw profileInvalid(`Unknown capability profile ${profileId}.`);
  }
  const profile = parseCapabilityProfile(raw);
  if (profile.id !== profileId) {
    throw profileInvalid(
      `Profile ${profileId} declares a mismatched id ${profile.id}.`,
    );
  }
  return profile;
}

export function parseCapabilityProfile(value: unknown): CapabilityProfile {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !PROFILE_ID.test(value.id) ||
    typeof value.version !== 'number' ||
    !Number.isInteger(value.version) ||
    value.version < 1 ||
    !isStringArray(value.implementationPaths) ||
    value.implementationPaths.length === 0 ||
    !isStringArray(value.evidencePaths) ||
    !isStringArray(value.policyPaths) ||
    !isStringArray(value.verificationInfrastructurePaths) ||
    !isStringArray(value.forbiddenPaths) ||
    !isStringArray(value.requiredChecks) ||
    !isRecord(value.constraints)
  ) {
    throw profileInvalid('Capability profile is malformed.');
  }
  const constraints = value.constraints;
  if (
    typeof constraints.evidenceOnlyGrantForbidden !== 'boolean' ||
    typeof constraints.samePackageRequired !== 'boolean' ||
    typeof constraints.evidenceAdditionsAllowed !== 'boolean' ||
    typeof constraints.maximumFiles !== 'number' ||
    !Number.isInteger(constraints.maximumFiles) ||
    constraints.maximumFiles < 1
  ) {
    throw profileInvalid('Capability profile constraints are malformed.');
  }

  const profile: CapabilityProfile = {
    id: value.id,
    version: value.version,
    implementationPaths: [...value.implementationPaths],
    evidencePaths: [...value.evidencePaths],
    policyPaths: [...value.policyPaths],
    verificationInfrastructurePaths: [...value.verificationInfrastructurePaths],
    forbiddenPaths: [...value.forbiddenPaths],
    constraints: {
      evidenceOnlyGrantForbidden: constraints.evidenceOnlyGrantForbidden,
      samePackageRequired: constraints.samePackageRequired,
      evidenceAdditionsAllowed: constraints.evidenceAdditionsAllowed,
      maximumFiles: constraints.maximumFiles,
    },
    requiredChecks: [...value.requiredChecks],
  };

  // A root that is both allowed and forbidden is a contradiction: forbidden
  // always wins, so the allow entry could never take effect and the profile
  // would silently mean something other than it reads.
  const allowed = [
    ...profile.implementationPaths,
    ...profile.evidencePaths,
    ...profile.policyPaths,
    ...profile.verificationInfrastructurePaths,
  ];
  for (const forbidden of profile.forbiddenPaths) {
    if (allowed.includes(forbidden)) {
      throw profileInvalid(
        `Capability profile lists ${forbidden} as both allowed and forbidden.`,
      );
    }
  }
  return profile;
}

export function classifyFileRole(
  profile: CapabilityProfile,
  filePath: string,
): FileRole | undefined {
  const normalized = normalizeExactRepositoryPath(filePath);
  if (matchesAny(profile.forbiddenPaths, normalized)) {
    return 'forbidden';
  }
  // Policy and verification infrastructure are checked before implementation
  // so a broad source root cannot silently absorb a governance file.
  if (matchesAny(profile.policyPaths, normalized)) {
    return 'policy';
  }
  if (matchesAny(profile.verificationInfrastructurePaths, normalized)) {
    return 'verification-infrastructure';
  }
  if (matchesAny(profile.evidencePaths, normalized)) {
    return 'evidence';
  }
  if (matchesAny(profile.implementationPaths, normalized)) {
    return 'implementation';
  }
  return undefined;
}

export function buildMaintainerPatchManifest(
  repositoryRoot: string,
  request: PatchManifestRequest,
): PatchManifest {
  const { profile, trustBaseCommit, policyDigest } = request;
  const changedPaths = listChangedPaths(repositoryRoot, trustBaseCommit);
  if (changedPaths.length === 0) {
    throw manifestError(
      'MAINTAINER_PATCH_EMPTY',
      'An exact-patch manifest requires at least one changed file.',
    );
  }
  if (changedPaths.length > profile.constraints.maximumFiles) {
    throw manifestError(
      'MAINTAINER_PATCH_TOO_LARGE',
      `Profile ${profile.id} admits at most ${profile.constraints.maximumFiles} files.`,
    );
  }

  const files = changedPaths
    .map((filePath) =>
      describeFile(repositoryRoot, profile, trustBaseCommit, filePath),
    )
    .sort((left, right) => (left.path < right.path ? -1 : 1));

  assertNoDuplicatePaths(files);
  assertRoleRelationships(profile, files);

  const manifest: PatchManifest = {
    schema: MANIFEST_SCHEMA,
    profile: profile.id,
    profileVersion: profile.version,
    trustBaseCommit,
    policyDigest,
    files,
    patchDigest: '',
  };
  return { ...manifest, patchDigest: digestManifestBody(manifest) };
}

export function canonicalPatchManifest(manifest: PatchManifest): string {
  return `${canonicalJson({
    schema: manifest.schema,
    profile: manifest.profile,
    profileVersion: manifest.profileVersion,
    trustBaseCommit: manifest.trustBaseCommit,
    policyDigest: manifest.policyDigest,
    files: manifest.files.map((file) => ({
      path: file.path,
      role: file.role,
      operation: file.operation,
      beforeBlobOid: file.beforeBlobOid,
      afterSha256: file.afterSha256,
      beforeMode: file.beforeMode,
      afterMode: file.afterMode,
    })),
    patchDigest: manifest.patchDigest,
  })}\n`;
}

/**
 * Re-derives every identity in the manifest from the working tree and rejects
 * any difference: an extra changed file, a missing one, altered content, or a
 * changed mode. This is what makes the signature bind the patch rather than
 * the paths.
 */
export function verifyPatchManifestAgainstWorktree(
  repositoryRoot: string,
  manifest: PatchManifest,
): void {
  const observed = listChangedPaths(repositoryRoot, manifest.trustBaseCommit);
  const expected = manifest.files.map((file) => file.path);
  if (
    observed.length !== expected.length ||
    observed.some((filePath, index) => filePath !== expected[index])
  ) {
    throw manifestError(
      'MAINTAINER_PATCH_DRIFT',
      'The working tree changed set differs from the signed manifest.',
      { expected, observed },
    );
  }
  for (const file of manifest.files) {
    const current = describeFile(
      repositoryRoot,
      undefined,
      manifest.trustBaseCommit,
      file.path,
      file.role,
    );
    if (
      current.operation !== file.operation ||
      current.beforeBlobOid !== file.beforeBlobOid ||
      current.afterSha256 !== file.afterSha256 ||
      current.beforeMode !== file.beforeMode ||
      current.afterMode !== file.afterMode
    ) {
      throw manifestError(
        'MAINTAINER_PATCH_DRIFT',
        `File ${file.path} no longer matches its signed identity.`,
        { path: file.path },
      );
    }
  }
}

function describeFile(
  repositoryRoot: string,
  profile: CapabilityProfile | undefined,
  trustBaseCommit: string,
  filePath: string,
  knownRole?: PatchManifestFile['role'],
): PatchManifestFile {
  const normalized = normalizeExactRepositoryPath(filePath);
  const role = knownRole ?? classifyRoleForManifest(profile, normalized);
  const before = readTrustBaseEntry(
    repositoryRoot,
    trustBaseCommit,
    normalized,
  );
  const after = readWorktreeEntry(repositoryRoot, normalized);

  if (!before && !after) {
    throw manifestError(
      'MAINTAINER_PATCH_DRIFT',
      `File ${normalized} exists in neither the trust base nor the working tree.`,
    );
  }
  const operation: PatchOperation = !before
    ? 'add'
    : !after
      ? 'delete'
      : 'modify';
  return {
    path: normalized,
    role,
    operation,
    beforeBlobOid: before?.oid ?? null,
    afterSha256: after?.sha256 ?? null,
    beforeMode: before?.mode ?? null,
    afterMode: after?.mode ?? null,
  };
}

function classifyRoleForManifest(
  profile: CapabilityProfile | undefined,
  filePath: string,
): PatchManifestFile['role'] {
  if (!profile) {
    throw manifestError(
      'MAINTAINER_PATH_UNCLASSIFIED',
      `File ${filePath} has no verified role.`,
    );
  }
  const role = classifyFileRole(profile, filePath);
  if (role === undefined) {
    throw manifestError(
      'MAINTAINER_PATH_UNCLASSIFIED',
      `File ${filePath} is outside every root of profile ${profile.id}.`,
      { path: filePath },
    );
  }
  if (role === 'forbidden') {
    throw manifestError(
      'MAINTAINER_PATH_FORBIDDEN',
      `File ${filePath} is forbidden by profile ${profile.id}.`,
      { path: filePath },
    );
  }
  return role;
}

function assertNoDuplicatePaths(files: PatchManifestFile[]): void {
  for (let index = 1; index < files.length; index += 1) {
    if (files[index]!.path === files[index - 1]!.path) {
      throw manifestError(
        'MAINTAINER_PATCH_DUPLICATE_PATH',
        `File ${files[index]!.path} appears more than once.`,
      );
    }
  }
}

function assertRoleRelationships(
  profile: CapabilityProfile,
  files: PatchManifestFile[],
): void {
  const implementation = files.filter((file) => file.role === 'implementation');
  const evidence = files.filter((file) => file.role === 'evidence');

  if (
    profile.constraints.evidenceOnlyGrantForbidden &&
    evidence.length > 0 &&
    implementation.length === 0
  ) {
    throw manifestError(
      'MAINTAINER_EVIDENCE_UNSUPPORTED',
      'Evidence files require at least one implementation file in the same patch.',
    );
  }
  if (profile.constraints.samePackageRequired) {
    const implementationPackages = new Set(
      implementation.map((file) => packageOf(file.path)),
    );
    for (const file of evidence) {
      if (!implementationPackages.has(packageOf(file.path))) {
        throw manifestError(
          'MAINTAINER_EVIDENCE_UNSUPPORTED',
          `Evidence ${file.path} has no implementation file in the same package.`,
          { path: file.path },
        );
      }
    }
  }
  if (!profile.constraints.evidenceAdditionsAllowed) {
    for (const file of evidence) {
      if (file.operation === 'add') {
        throw manifestError(
          'MAINTAINER_EVIDENCE_UNSUPPORTED',
          `Profile ${profile.id} does not admit new evidence files (${file.path}).`,
          { path: file.path },
        );
      }
    }
  }
}

function packageOf(filePath: string): string {
  const segments = filePath.split('/');
  return segments.length >= 2 && segments[0] === 'packages'
    ? `packages/${segments[1]}`
    : segments[0]!;
}

function readTrustBaseEntry(
  repositoryRoot: string,
  trustBaseCommit: string,
  filePath: string,
): { oid: string; mode: string } | undefined {
  const output = runGit(
    repositoryRoot,
    ['ls-tree', '-z', trustBaseCommit, '--', filePath],
    true,
  );
  const entry = output.split('\0').filter(Boolean)[0];
  if (!entry) {
    return undefined;
  }
  const match = /^(\d{6}) (blob|commit|tree) ([0-9a-f]{40,64})\t/.exec(entry);
  if (!match || match[2] !== 'blob' || !GIT_MODES.has(match[1]!)) {
    throw manifestError(
      'MAINTAINER_PATH_UNSAFE',
      `File ${filePath} is not a plain tracked file in the trust base.`,
      { path: filePath },
    );
  }
  return { oid: match[3]!, mode: match[1]! };
}

function readWorktreeEntry(
  repositoryRoot: string,
  filePath: string,
): { sha256: string; mode: string } | undefined {
  const absolute = path.join(repositoryRoot, filePath);
  const stats = fs.lstatSync(absolute, { throwIfNoEntry: false });
  if (!stats) {
    return undefined;
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw manifestError(
      'MAINTAINER_PATH_UNSAFE',
      `File ${filePath} must be a regular non-symlink file.`,
      { path: filePath },
    );
  }
  const mode = (stats.mode & 0o111) === 0 ? '100644' : '100755';
  if (mode !== '100644') {
    throw manifestError(
      'MAINTAINER_PATH_UNSAFE',
      `File ${filePath} must not be executable.`,
      { path: filePath },
    );
  }
  return {
    sha256: crypto
      .createHash('sha256')
      .update(fs.readFileSync(absolute))
      .digest('hex'),
    mode,
  };
}

function digestManifestBody(manifest: PatchManifest): string {
  return crypto
    .createHash('sha256')
    .update(canonicalPatchManifest({ ...manifest, patchDigest: '' }))
    .digest('hex');
}

function matchesAny(patterns: string[], filePath: string): boolean {
  return patterns.some((pattern) => matchesAllowedPath(filePath, pattern));
}

function profileInvalid(message: string) {
  return workflowError('MAINTAINER_PROFILE_INVALID', message, ExitCode.guard);
}

function manifestError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
) {
  return workflowError(
    code,
    message,
    ExitCode.guard,
    details ? { details } : {},
  );
}
