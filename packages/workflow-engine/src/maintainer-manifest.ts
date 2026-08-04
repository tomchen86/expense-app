import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from './canonical-json.ts';
import { isRecord, isStringArray } from './contract-values.ts';
import { ExitCode, workflowError } from './errors.ts';
import { listChangedPaths, runGit } from './git.ts';
import {
  matchesAllowedPath,
  normalizeExactRepositoryPath,
  normalizePolicyPath,
} from './paths.ts';

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
const COMMIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const BLOB_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DIGEST = /^[0-9a-f]{64}$/;
const CHECK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CHECK_DEPENDENCIES = new Set([
  'source-tree',
  'base-commit',
  'harness-engine',
  'policy',
  'runner',
  'external-state',
]);
const PROFILE_KEYS = [
  'id',
  'version',
  'authorityClass',
  'implementationPaths',
  'evidencePaths',
  'policyPaths',
  'verificationInfrastructurePaths',
  'forbiddenPaths',
  'constraints',
  'requiredChecks',
  'checkDependencies',
];
const PROFILE_KEYS_WITH_EXTERNAL_FRESHNESS = [
  ...PROFILE_KEYS,
  'externalStateFreshness',
];
const PROFILE_CONSTRAINT_KEYS = [
  'evidenceOnlyGrantForbidden',
  'samePackageRequired',
  'evidenceAdditionsAllowed',
  'maximumFiles',
];
const MANIFEST_KEYS = [
  'schema',
  'profile',
  'profileVersion',
  'trustBaseCommit',
  'policyDigest',
  'files',
  'patchDigest',
];
const MANIFEST_FILE_KEYS = [
  'path',
  'role',
  'operation',
  'beforeBlobOid',
  'afterSha256',
  'beforeMode',
  'afterMode',
];

export type FileRole =
  | 'implementation'
  | 'evidence'
  | 'policy'
  | 'verification-infrastructure'
  | 'forbidden';

export type CheckDependency =
  | 'source-tree'
  | 'base-commit'
  | 'harness-engine'
  | 'policy'
  | 'runner'
  | 'external-state';

export type ProfileAuthorityClass =
  'ordinary' | 'root-one-shot' | 'control-plane';

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
  authorityClass: ProfileAuthorityClass;
  implementationPaths: string[];
  evidencePaths: string[];
  policyPaths: string[];
  verificationInfrastructurePaths: string[];
  forbiddenPaths: string[];
  constraints: CapabilityProfileConstraints;
  requiredChecks: string[];
  checkDependencies: Record<string, CheckDependency[]>;
  externalStateFreshness?: Record<string, { maxAgeMs: number }>;
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
    !hasExactKeys(parsed, ['schemaVersion', 'profiles']) ||
    parsed.schemaVersion !== 1 ||
    !isRecord(parsed.profiles)
  ) {
    throw profileInvalid('Maintainer profiles file is malformed.');
  }
  const profiles = Object.fromEntries(
    Object.entries(parsed.profiles).map(([declaredId, raw]) => {
      if (!PROFILE_ID.test(declaredId)) {
        throw profileInvalid(
          'Maintainer profiles file contains an invalid ID.',
        );
      }
      const profile = parseCapabilityProfile(raw);
      if (profile.id !== declaredId) {
        throw profileInvalid(
          `Profile ${declaredId} declares a mismatched id ${profile.id}.`,
        );
      }
      return [declaredId, profile];
    }),
  );
  const profile = profiles[profileId];
  if (!profile) {
    throw profileInvalid(`Unknown capability profile ${profileId}.`);
  }
  return profile;
}

export function parseCapabilityProfile(value: unknown): CapabilityProfile {
  if (
    !isRecord(value) ||
    (!hasExactKeys(value, PROFILE_KEYS) &&
      !hasExactKeys(value, PROFILE_KEYS_WITH_EXTERNAL_FRESHNESS)) ||
    typeof value.id !== 'string' ||
    !PROFILE_ID.test(value.id) ||
    typeof value.version !== 'number' ||
    !Number.isInteger(value.version) ||
    value.version < 1 ||
    (value.authorityClass !== 'ordinary' &&
      value.authorityClass !== 'root-one-shot' &&
      value.authorityClass !== 'control-plane') ||
    !isStringArray(value.implementationPaths) ||
    value.implementationPaths.length === 0 ||
    !isStringArray(value.evidencePaths) ||
    !isStringArray(value.policyPaths) ||
    !isStringArray(value.verificationInfrastructurePaths) ||
    !isStringArray(value.forbiddenPaths) ||
    !isStringArray(value.requiredChecks) ||
    value.requiredChecks.length === 0 ||
    !isRecord(value.checkDependencies) ||
    !isRecord(value.constraints)
  ) {
    throw profileInvalid('Capability profile is malformed.');
  }
  const constraints = value.constraints;
  if (
    !hasExactKeys(constraints, PROFILE_CONSTRAINT_KEYS) ||
    typeof constraints.evidenceOnlyGrantForbidden !== 'boolean' ||
    typeof constraints.samePackageRequired !== 'boolean' ||
    typeof constraints.evidenceAdditionsAllowed !== 'boolean' ||
    typeof constraints.maximumFiles !== 'number' ||
    !Number.isInteger(constraints.maximumFiles) ||
    constraints.maximumFiles < 1 ||
    constraints.maximumFiles > 1000
  ) {
    throw profileInvalid('Capability profile constraints are malformed.');
  }

  const requiredChecks = value.requiredChecks as string[];
  const rawCheckDependencies = value.checkDependencies as Record<
    string,
    unknown
  >;
  assertSortedUniqueProfileValues(requiredChecks, 'requiredChecks', (entry) =>
    CHECK_ID.test(entry),
  );
  const dependencyIds = Object.keys(rawCheckDependencies).sort();
  if (
    dependencyIds.length !== requiredChecks.length ||
    dependencyIds.some((checkId, index) => checkId !== requiredChecks[index])
  ) {
    throw profileInvalid(
      'Capability profile checkDependencies must exactly cover requiredChecks.',
    );
  }
  const checkDependencies = Object.fromEntries(
    requiredChecks.map((checkId) => {
      const dependencies = rawCheckDependencies[checkId];
      if (!isStringArray(dependencies) || dependencies.length === 0) {
        throw profileInvalid(
          `Capability profile check ${checkId} has no valid dependencies.`,
        );
      }
      assertSortedUniqueProfileValues(
        dependencies,
        `checkDependencies.${checkId}`,
        (entry) => CHECK_DEPENDENCIES.has(entry),
      );
      return [checkId, [...dependencies] as CheckDependency[]];
    }),
  );
  const externalCheckIds = requiredChecks.filter((checkId) =>
    checkDependencies[checkId]!.includes('external-state'),
  );
  let externalStateFreshness: Record<string, { maxAgeMs: number }> | undefined;
  if (value.externalStateFreshness !== undefined) {
    if (!isRecord(value.externalStateFreshness)) {
      throw profileInvalid(
        'Capability profile external-state freshness policy is malformed.',
      );
    }
    const rawExternalStateFreshness = value.externalStateFreshness as Record<
      string,
      unknown
    >;
    const freshnessIds = Object.keys(rawExternalStateFreshness).sort();
    if (
      freshnessIds.length !== externalCheckIds.length ||
      freshnessIds.some((checkId, index) => checkId !== externalCheckIds[index])
    ) {
      throw profileInvalid(
        'Capability profile externalStateFreshness must exactly cover external-state checks.',
      );
    }
    externalStateFreshness = Object.fromEntries(
      freshnessIds.map((checkId) => {
        const freshness = rawExternalStateFreshness[checkId];
        if (
          !isRecord(freshness) ||
          !hasExactKeys(freshness, ['maxAgeMs']) ||
          !Number.isSafeInteger(freshness.maxAgeMs) ||
          Number(freshness.maxAgeMs) < 1
        ) {
          throw profileInvalid(
            `Capability profile external-state freshness for ${checkId} is malformed.`,
          );
        }
        return [checkId, { maxAgeMs: Number(freshness.maxAgeMs) }];
      }),
    );
  } else if (externalCheckIds.length > 0) {
    throw profileInvalid(
      'Capability profile external-state checks require a freshness policy.',
    );
  }

  const profile: CapabilityProfile = {
    id: value.id,
    version: value.version,
    authorityClass: value.authorityClass,
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
    requiredChecks: [...requiredChecks],
    checkDependencies,
    ...(externalStateFreshness ? { externalStateFreshness } : {}),
  };

  for (const [label, paths] of [
    ['implementationPaths', profile.implementationPaths],
    ['evidencePaths', profile.evidencePaths],
    ['policyPaths', profile.policyPaths],
    [
      'verificationInfrastructurePaths',
      profile.verificationInfrastructurePaths,
    ],
    ['forbiddenPaths', profile.forbiddenPaths],
  ] as const) {
    assertSortedUniqueProfileValues(paths, label, (entry) => {
      try {
        return normalizePolicyPath(entry) === entry;
      } catch {
        return false;
      }
    });
  }
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

function assertSortedUniqueProfileValues(
  values: string[],
  label: string,
  valid: (value: string) => boolean,
): void {
  const sorted = [...new Set(values)].sort();
  const caseFolded = new Set(values.map((value) => value.toLowerCase()));
  if (
    values.length !== sorted.length ||
    values.length !== caseFolded.size ||
    values.some((value, index) => value !== sorted[index] || !valid(value))
  ) {
    throw profileInvalid(
      `Capability profile ${label} must be valid, sorted, and unique.`,
    );
  }
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

export function parsePatchManifest(value: string | unknown): PatchManifest {
  let parsed: unknown = value;
  try {
    if (typeof value === 'string') {
      if (value.length > 1_048_576) {
        throw new Error('manifest is too large');
      }
      parsed = JSON.parse(value);
    }
  } catch {
    throw manifestError(
      'MAINTAINER_PATCH_INVALID',
      'Maintainer patch manifest is not valid JSON.',
    );
  }
  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, MANIFEST_KEYS) ||
    parsed.schema !== MANIFEST_SCHEMA ||
    typeof parsed.profile !== 'string' ||
    !PROFILE_ID.test(parsed.profile) ||
    typeof parsed.profileVersion !== 'number' ||
    !Number.isInteger(parsed.profileVersion) ||
    parsed.profileVersion < 1 ||
    typeof parsed.trustBaseCommit !== 'string' ||
    !COMMIT_OID.test(parsed.trustBaseCommit) ||
    typeof parsed.policyDigest !== 'string' ||
    !DIGEST.test(parsed.policyDigest) ||
    !Array.isArray(parsed.files) ||
    parsed.files.length === 0 ||
    typeof parsed.patchDigest !== 'string' ||
    !DIGEST.test(parsed.patchDigest)
  ) {
    throw manifestError(
      'MAINTAINER_PATCH_INVALID',
      'Maintainer patch manifest is malformed.',
    );
  }

  const files = parsed.files.map((raw): PatchManifestFile => {
    if (
      !isRecord(raw) ||
      !hasExactKeys(raw, MANIFEST_FILE_KEYS) ||
      typeof raw.path !== 'string' ||
      (raw.role !== 'implementation' &&
        raw.role !== 'evidence' &&
        raw.role !== 'policy' &&
        raw.role !== 'verification-infrastructure') ||
      (raw.operation !== 'add' &&
        raw.operation !== 'modify' &&
        raw.operation !== 'delete') ||
      (raw.beforeBlobOid !== null &&
        (typeof raw.beforeBlobOid !== 'string' ||
          !BLOB_OID.test(raw.beforeBlobOid))) ||
      (raw.afterSha256 !== null &&
        (typeof raw.afterSha256 !== 'string' ||
          !DIGEST.test(raw.afterSha256))) ||
      (raw.beforeMode !== null &&
        (typeof raw.beforeMode !== 'string' ||
          !GIT_MODES.has(raw.beforeMode))) ||
      (raw.afterMode !== null &&
        (typeof raw.afterMode !== 'string' || !GIT_MODES.has(raw.afterMode)))
    ) {
      throw manifestError(
        'MAINTAINER_PATCH_INVALID',
        'Maintainer patch manifest contains a malformed file entry.',
      );
    }
    let normalized: string;
    try {
      normalized = normalizeExactRepositoryPath(raw.path);
    } catch {
      throw manifestError(
        'MAINTAINER_PATCH_INVALID',
        'Maintainer patch manifest contains an invalid exact path.',
      );
    }
    if (
      normalized !== raw.path ||
      (raw.operation === 'add' &&
        (raw.beforeBlobOid !== null ||
          raw.beforeMode !== null ||
          raw.afterSha256 === null ||
          raw.afterMode === null)) ||
      (raw.operation === 'modify' &&
        (raw.beforeBlobOid === null ||
          raw.beforeMode === null ||
          raw.afterSha256 === null ||
          raw.afterMode === null)) ||
      (raw.operation === 'delete' &&
        (raw.beforeBlobOid === null ||
          raw.beforeMode === null ||
          raw.afterSha256 !== null ||
          raw.afterMode !== null))
    ) {
      throw manifestError(
        'MAINTAINER_PATCH_INVALID',
        'Maintainer patch manifest file identities do not match the operation.',
      );
    }
    return {
      path: raw.path,
      role: raw.role,
      operation: raw.operation,
      beforeBlobOid: raw.beforeBlobOid,
      afterSha256: raw.afterSha256,
      beforeMode: raw.beforeMode,
      afterMode: raw.afterMode,
    };
  });
  if (
    files.some(
      (file, index) => index > 0 && file.path <= files[index - 1]!.path,
    ) ||
    new Set(files.map(({ path: filePath }) => filePath.toLowerCase())).size !==
      files.length
  ) {
    throw manifestError(
      'MAINTAINER_PATCH_INVALID',
      'Maintainer patch manifest paths must be sorted, unique, and free of case aliases.',
    );
  }

  const manifest: PatchManifest = {
    schema: MANIFEST_SCHEMA,
    profile: parsed.profile,
    profileVersion: parsed.profileVersion,
    trustBaseCommit: parsed.trustBaseCommit,
    policyDigest: parsed.policyDigest,
    files,
    patchDigest: parsed.patchDigest,
  };
  if (manifest.patchDigest !== digestManifestBody(manifest)) {
    throw manifestError(
      'MAINTAINER_PATCH_INVALID',
      'Maintainer patch manifest digest does not match its canonical content.',
    );
  }
  if (typeof value === 'string' && canonicalPatchManifest(manifest) !== value) {
    throw manifestError(
      'MAINTAINER_PATCH_INVALID',
      'Maintainer patch manifest is not canonical.',
    );
  }
  return manifest;
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

/**
 * Revalidates the signed manifest against only trust-base facts. This is the
 * admission check used by a clean authority worktree before the candidate is
 * materialized there; after materialization, verifyPatchManifestAgainstWorktree
 * additionally proves every after-byte and mode.
 */
export function validatePatchManifestAgainstProfile(
  repositoryRoot: string,
  manifest: PatchManifest,
  profile: CapabilityProfile,
): void {
  if (
    manifest.profile !== profile.id ||
    manifest.profileVersion !== profile.version ||
    manifest.files.length > profile.constraints.maximumFiles
  ) {
    throw manifestError(
      'MAINTAINER_PATCH_INVALID',
      'Maintainer patch manifest does not match its capability profile.',
    );
  }
  for (const file of manifest.files) {
    if (
      file.role === 'evidence' &&
      (file.beforeMode === '100755' || file.afterMode === '100755')
    ) {
      throw manifestError(
        'MAINTAINER_PATH_UNSAFE',
        `Evidence ${file.path} must never be executable.`,
        { path: file.path },
      );
    }
    if (classifyFileRole(profile, file.path) !== file.role) {
      throw manifestError(
        'MAINTAINER_PATCH_INVALID',
        `File ${file.path} does not carry its trust-base role.`,
        { path: file.path },
      );
    }
    const before = readTrustBaseEntry(
      repositoryRoot,
      manifest.trustBaseCommit,
      file.path,
    );
    if (
      before?.oid !== (file.beforeBlobOid ?? undefined) ||
      before?.mode !== (file.beforeMode ?? undefined)
    ) {
      throw manifestError(
        'MAINTAINER_PATCH_INVALID',
        `File ${file.path} no longer matches the trust base.`,
        { path: file.path },
      );
    }
  }
  assertRoleRelationships(profile, manifest.files);
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
  if (
    role === 'evidence' &&
    (before?.mode === '100755' || after?.mode === '100755')
  ) {
    throw manifestError(
      'MAINTAINER_PATH_UNSAFE',
      `Evidence ${normalized} must never be executable.`,
      { path: normalized },
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
  const identities = new Set<string>();
  for (const file of files) {
    const identity = file.path.toLowerCase();
    if (identities.has(identity)) {
      throw manifestError(
        'MAINTAINER_PATCH_DUPLICATE_PATH',
        `File ${file.path} appears more than once or aliases another path by case.`,
      );
    }
    identities.add(identity);
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

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
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
