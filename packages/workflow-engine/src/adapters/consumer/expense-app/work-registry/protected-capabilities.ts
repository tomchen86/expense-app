import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  canonicalJson,
  compareCanonicalStrings,
} from '../../../../foundation/canonical-json/canonical-json.ts';
import {
  isRecord,
  isStringArray,
} from '../../../../foundation/canonical-json/contract-values.ts';
import {
  ExitCode,
  workflowError,
} from '../../../../foundation/errors/errors.ts';
import {
  runGit,
  runGitBuffer,
} from '../../../../runtime/repository-transaction/git.ts';
import {
  matchesAllowedPath,
  normalizeExactRepositoryPath,
  normalizePolicyPath,
} from '../../../../runtime/session-workspace/paths.ts';

const MANIFEST_PATH = 'workflow/protected-capabilities.json';
const LOADER_PATH =
  'packages/workflow-engine/src/adapters/consumer/expense-app/work-registry/protected-capabilities.ts';
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REGULAR_GIT_MODES = new Set(['100644', '100755']);

export const REQUIRED_PROTECTED_CAPABILITIES = [
  'adoption.journal',
  'apply.journal',
  'audit.append',
  'authorization.verify',
  'control-plane.update',
  'effect.monitor',
  'human.trust-roots',
  'policy.classify',
  'recovery.rollback',
  'ref-generation.ledger',
  'sandbox.enforce',
  'workflow.abort-or-supersede',
] as const;

export type ProtectedCapability =
  (typeof REQUIRED_PROTECTED_CAPABILITIES)[number];

export type Sha256Digest = `sha256:${string}`;

export type ProtectedCapabilityEntry = {
  capability: ProtectedCapability;
  entrypoints: string[];
  dependencies: string[];
  contentDigest: Sha256Digest;
  closureDigest: Sha256Digest;
};

export type ProtectedCapabilitiesManifest = {
  kind: 'protected-capability-manifest.v1';
  schemaVersion: 1;
  manifestPath: typeof MANIFEST_PATH;
  entries: ProtectedCapabilityEntry[];
  manifestDigest: Sha256Digest;
};

export type ProtectedCapabilitiesManifestSource = Omit<
  ProtectedCapabilitiesManifest,
  'manifestDigest'
>;

type TreeEntry = {
  path: string;
  mode: string;
  objectId: string;
};

type ClosureIdentity =
  | TreeEntry
  | {
      path: typeof MANIFEST_PATH;
      mode: 'manifest-self';
      objectId: 'manifest-self';
    };

export type ProtectedCapabilityEntryDigests = {
  contentDigest: Sha256Digest;
  closureDigest: Sha256Digest;
};

export function computeProtectedCapabilityEntryDigests(
  repositoryRoot: string,
  trustBaseCommit: string,
  input: { entrypoints: string[]; dependencies: string[] },
): ProtectedCapabilityEntryDigests {
  const entrypoints = validatePolicyPaths(
    input.entrypoints,
    'entrypoints',
    true,
  );
  const dependencies = validatePolicyPaths(
    input.dependencies,
    'dependencies',
    false,
  );
  assertNoCaseFoldAliases([...entrypoints, ...dependencies]);
  const tree = readTrustBaseTree(repositoryRoot, trustBaseCommit);
  const identities = resolveClosureIdentities(tree, [
    ...entrypoints,
    ...dependencies,
  ]);
  return entryDigests(entrypoints, dependencies, identities);
}

export function computeProtectedCapabilityEntryDigestsFromWorktree(
  repositoryRoot: string,
  input: { entrypoints: string[]; dependencies: string[] },
): ProtectedCapabilityEntryDigests {
  const entrypoints = validatePolicyPaths(
    input.entrypoints,
    'entrypoints',
    true,
  );
  const dependencies = validatePolicyPaths(
    input.dependencies,
    'dependencies',
    false,
  );
  assertNoCaseFoldAliases([...entrypoints, ...dependencies]);
  const identities = resolveClosureIdentities(
    readWorktreeFiles(repositoryRoot),
    [...entrypoints, ...dependencies],
  );
  return entryDigests(entrypoints, dependencies, identities);
}

function entryDigests(
  entrypoints: string[],
  dependencies: string[],
  identities: ClosureIdentity[],
): ProtectedCapabilityEntryDigests {
  const contentDigest = digest(
    canonicalJson({
      kind: 'protected-capability-content.v1',
      files: identities,
    }),
  );
  const closureDigest = digest(
    canonicalJson({ entrypoints, dependencies, contentDigest }),
  );
  return { contentDigest, closureDigest };
}

export function loadProtectedCapabilitiesFromTrustBase(
  repositoryRoot: string,
  trustBaseCommit: string,
): ProtectedCapabilitiesManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      runGit(repositoryRoot, ['show', `${trustBaseCommit}:${MANIFEST_PATH}`]),
    ) as unknown;
  } catch {
    throw protectedManifestInvalid(
      'The trust base has no readable protected capability manifest.',
    );
  }
  const payload = parseProtectedCapabilitiesManifestSource(parsed);
  for (const entry of payload.entries) {
    const observed = computeProtectedCapabilityEntryDigests(
      repositoryRoot,
      trustBaseCommit,
      entry,
    );
    if (
      observed.contentDigest !== entry.contentDigest ||
      observed.closureDigest !== entry.closureDigest
    ) {
      throw workflowError(
        'PROTECTED_CAPABILITY_CLOSURE_DIGEST_MISMATCH',
        `Protected capability ${entry.capability} no longer matches its trust-base dependency closure.`,
        ExitCode.verification,
      );
    }
  }

  return {
    ...payload,
    manifestDigest: digest(canonicalJson(payload)),
  };
}

export function parseProtectedCapabilitiesManifestSource(
  parsed: unknown,
): ProtectedCapabilitiesManifestSource {
  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, [
      'kind',
      'schemaVersion',
      'manifestPath',
      'entries',
    ]) ||
    parsed.kind !== 'protected-capability-manifest.v1' ||
    parsed.schemaVersion !== 1 ||
    parsed.manifestPath !== MANIFEST_PATH ||
    !Array.isArray(parsed.entries)
  ) {
    throw protectedManifestInvalid(
      'The protected capability manifest is malformed.',
    );
  }

  const entries = parsed.entries.map(parseManifestEntry);
  const capabilities = entries.map(({ capability }) => capability);
  if (
    capabilities.length !== REQUIRED_PROTECTED_CAPABILITIES.length ||
    capabilities.some(
      (capability, index) =>
        capability !== REQUIRED_PROTECTED_CAPABILITIES[index],
    )
  ) {
    throw protectedManifestInvalid(
      'The protected capability manifest must contain every required capability exactly once in canonical order.',
    );
  }

  const declaredPaths = entries.flatMap(({ entrypoints, dependencies }) => [
    ...entrypoints,
    ...dependencies,
  ]);
  assertNoCaseFoldAliases(declaredPaths);
  if (
    !declaredPaths.some((entry) => matchesAllowedPath(MANIFEST_PATH, entry)) ||
    !declaredPaths.some((entry) => matchesAllowedPath(LOADER_PATH, entry))
  ) {
    throw protectedManifestInvalid(
      'The protected capability manifest must protect itself and its loader.',
    );
  }

  return {
    kind: 'protected-capability-manifest.v1' as const,
    schemaVersion: 1 as const,
    manifestPath: MANIFEST_PATH,
    entries,
  };
}

export function classifyProtectedCapabilityPaths(
  repositoryRoot: string,
  trustBaseCommit: string,
  requestedPaths: string[],
): {
  protectedPaths: string[];
  affectedCapabilities: ProtectedCapability[];
  manifestDigest: string;
} {
  const manifest = loadProtectedCapabilitiesFromTrustBase(
    repositoryRoot,
    trustBaseCommit,
  );
  const paths = requestedPaths.map(normalizeExactRepositoryPath);
  const unique = [...new Set(paths)].sort(compareCanonicalStrings);
  assertNoCaseFoldAliases(paths);
  if (unique.length !== paths.length) {
    throw protectedManifestInvalid(
      'Protected capability classification requires unique exact paths.',
    );
  }
  const affectedCapabilities = manifest.entries
    .filter(({ entrypoints, dependencies }) =>
      paths.some((filePath) =>
        [...entrypoints, ...dependencies].some((protectedPath) =>
          matchesAllowedPath(filePath, protectedPath),
        ),
      ),
    )
    .map(({ capability }) => capability);
  const affected = new Set(affectedCapabilities);
  return {
    protectedPaths: unique.filter((filePath) =>
      manifest.entries.some(
        ({ capability, entrypoints, dependencies }) =>
          affected.has(capability) &&
          [...entrypoints, ...dependencies].some((protectedPath) =>
            matchesAllowedPath(filePath, protectedPath),
          ),
      ),
    ),
    affectedCapabilities,
    manifestDigest: manifest.manifestDigest,
  };
}

function parseManifestEntry(value: unknown): ProtectedCapabilityEntry {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'capability',
      'entrypoints',
      'dependencies',
      'contentDigest',
      'closureDigest',
    ]) ||
    typeof value.capability !== 'string' ||
    !isProtectedCapability(value.capability) ||
    !isStringArray(value.entrypoints) ||
    !isStringArray(value.dependencies) ||
    typeof value.contentDigest !== 'string' ||
    !DIGEST.test(value.contentDigest) ||
    typeof value.closureDigest !== 'string' ||
    !DIGEST.test(value.closureDigest)
  ) {
    throw protectedManifestInvalid(
      'The protected capability manifest contains a malformed entry.',
    );
  }
  const entrypoints = validatePolicyPaths(
    value.entrypoints,
    'entrypoints',
    true,
  );
  const dependencies = validatePolicyPaths(
    value.dependencies,
    'dependencies',
    false,
  );
  assertNoCaseFoldAliases([...entrypoints, ...dependencies]);
  return {
    capability: value.capability,
    entrypoints,
    dependencies,
    contentDigest: value.contentDigest as Sha256Digest,
    closureDigest: value.closureDigest as Sha256Digest,
  };
}

function validatePolicyPaths(
  values: string[],
  label: string,
  requireNonEmpty: boolean,
): string[] {
  if (requireNonEmpty && values.length === 0) {
    throw protectedManifestInvalid(
      `Protected capability ${label} cannot be empty.`,
    );
  }
  const normalized = values.map((entry) => {
    try {
      return normalizePolicyPath(entry);
    } catch {
      throw protectedManifestInvalid(
        `Protected capability ${label} contain an unsafe repository path.`,
      );
    }
  });
  const sorted = [...new Set(normalized)].sort(compareCanonicalStrings);
  if (
    sorted.length !== normalized.length ||
    normalized.some((entry, index) => entry !== sorted[index])
  ) {
    throw protectedManifestInvalid(
      `Protected capability ${label} must be normalized, sorted, and unique.`,
    );
  }
  return normalized;
}

function assertNoCaseFoldAliases(paths: readonly string[]): void {
  const aliases = new Map<string, string>();
  for (const entry of paths) {
    const key = entry.toLocaleLowerCase('en-US');
    const previous = aliases.get(key);
    if (previous !== undefined && previous !== entry) {
      throw protectedManifestInvalid(
        'Protected capability paths contain a case-fold alias.',
      );
    }
    aliases.set(key, entry);
  }
}

function readTrustBaseTree(
  repositoryRoot: string,
  trustBaseCommit: string,
): TreeEntry[] {
  let output: string;
  try {
    output = runGit(repositoryRoot, [
      '-c',
      'core.quotePath=false',
      'ls-tree',
      '-r',
      '--full-tree',
      trustBaseCommit,
    ]);
  } catch {
    throw protectedManifestInvalid(
      'The protected capability trust-base tree is unreadable.',
    );
  }
  if (!output) return [];
  return output
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const tab = line.indexOf('\t');
      const metadata = tab === -1 ? [] : line.slice(0, tab).split(' ');
      const filePath = tab === -1 ? '' : line.slice(tab + 1);
      const [mode, type, objectId] = metadata;
      let normalizedPath: string;
      try {
        normalizedPath = normalizeExactRepositoryPath(filePath);
      } catch {
        throw protectedManifestInvalid(
          'The protected capability trust-base tree contains an unsafe path.',
        );
      }
      if (
        metadata.length !== 3 ||
        mode === undefined ||
        objectId === undefined ||
        !OBJECT_ID.test(objectId)
      ) {
        throw protectedManifestInvalid(
          'The protected capability trust-base tree contains an unsupported object.',
        );
      }
      return type === 'blob'
        ? { path: normalizedPath, mode, objectId }
        : { path: normalizedPath, mode: 'unsupported', objectId };
    });
}

function readWorktreeFiles(repositoryRoot: string): TreeEntry[] {
  let root: string;
  let objectFormat: string;
  let output: Buffer;
  try {
    root = fs.realpathSync(repositoryRoot);
    objectFormat = runGit(repositoryRoot, [
      'rev-parse',
      '--show-object-format',
    ]).trim();
    output = runGitBuffer(repositoryRoot, [
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
    ]);
  } catch {
    throw protectedManifestInvalid(
      'The protected capability candidate worktree is unreadable.',
    );
  }
  if (objectFormat !== 'sha1' && objectFormat !== 'sha256') {
    throw protectedManifestInvalid(
      'The protected capability candidate uses an unsupported Git object format.',
    );
  }
  const rawPaths = output
    .toString('utf8')
    .split('\0')
    .filter((entry) => entry.length > 0);
  const normalizedPaths = rawPaths.map((entry) => {
    try {
      return normalizeExactRepositoryPath(entry);
    } catch {
      throw protectedManifestInvalid(
        'The protected capability candidate contains an unsafe path.',
      );
    }
  });
  return normalizedPaths.flatMap((filePath): TreeEntry[] => {
    const absolute = path.join(root, filePath);
    const stats = fs.lstatSync(absolute, { throwIfNoEntry: false });
    if (stats === undefined) return [];
    if (!stats.isFile() || stats.isSymbolicLink()) {
      return [{ path: filePath, mode: 'unsupported', objectId: 'unsupported' }];
    }
    const content = fs.readFileSync(absolute);
    const header = Buffer.from(`blob ${content.length}\0`);
    const objectId = crypto
      .createHash(objectFormat)
      .update(header)
      .update(content)
      .digest('hex');
    return [
      {
        path: filePath,
        mode: (stats.mode & 0o111) === 0 ? '100644' : '100755',
        objectId,
      },
    ];
  });
}

function resolveClosureIdentities(
  tree: TreeEntry[],
  declaredPaths: string[],
): ClosureIdentity[] {
  const identities = new Map<string, ClosureIdentity>();
  for (const declaredPath of [...new Set(declaredPaths)]) {
    const matches = tree.filter(({ path }) =>
      matchesAllowedPath(path, declaredPath),
    );
    const protectsManifest = matchesAllowedPath(MANIFEST_PATH, declaredPath);
    if (matches.length === 0 && !protectsManifest) {
      throw protectedManifestInvalid(
        `Protected capability path ${declaredPath} does not resolve in the trust base.`,
      );
    }
    if (protectsManifest) {
      identities.set(MANIFEST_PATH, {
        path: MANIFEST_PATH,
        mode: 'manifest-self',
        objectId: 'manifest-self',
      });
    }
    for (const match of matches) {
      if (match.path === MANIFEST_PATH) continue;
      if (!REGULAR_GIT_MODES.has(match.mode)) {
        throw protectedManifestInvalid(
          `Protected capability path ${match.path} is not a regular executable or data file.`,
        );
      }
      identities.set(match.path, match);
    }
  }
  const resolved = [...identities.values()].sort((left, right) =>
    compareCanonicalStrings(left.path, right.path),
  );
  assertNoCaseFoldAliases(resolved.map(({ path: filePath }) => filePath));
  return resolved;
}

function isProtectedCapability(value: string): value is ProtectedCapability {
  return (REQUIRED_PROTECTED_CAPABILITIES as readonly string[]).includes(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: string[],
): boolean {
  const keys = Object.keys(value).sort(compareCanonicalStrings);
  const sortedExpected = [...expected].sort(compareCanonicalStrings);
  return (
    keys.length === sortedExpected.length &&
    keys.every((entry, index) => entry === sortedExpected[index])
  );
}

function digest(value: string): Sha256Digest {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function protectedManifestInvalid(message: string) {
  return workflowError(
    'PROTECTED_CAPABILITY_MANIFEST_INVALID',
    message,
    ExitCode.guard,
  );
}
