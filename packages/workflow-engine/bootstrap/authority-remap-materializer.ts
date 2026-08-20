import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../src/foundation/errors/errors.ts';
import {
  projectAuthorityRemap,
  projectAuthorityRemapChecks,
  projectAuthorityRemapGuards,
  projectAuthorityRemapMaintainerPolicy,
  projectAuthorityRemapPathRoles,
  projectAuthorityRemapProfiles,
  type AuthorityRemapManifestV1,
  type AuthorityRemapPlanIntent,
  type AuthorityRemapProjection,
} from '../src/composition-root/authority-remap.ts';
import {
  classifyFileRole,
  loadCapabilityProfileFromTrustBase,
} from '../src/modules/authority/maintainer-manifest.ts';
import { parseAuthorityPlanIntent } from '../src/application/control-plane/authority-plan.ts';
import {
  parseProtectedCapabilitiesManifestSource,
  type ProtectedCapabilitiesManifestSource,
} from '../src/adapters/consumer/expense-app/work-registry/protected-capabilities.ts';
import { runGitBuffer } from '../src/runtime/repository-transaction/git.ts';
import {
  matchesAllowedPath,
  normalizeExactRepositoryPath,
} from '../src/runtime/session-workspace/paths.ts';
import { generateBuiltInEngineClosure } from './generate-built-in-engine-closure.ts';
import { generateHarnessBootstrapRuntime } from './generate-harness-bootstrap-runtime.ts';
import { generateProtectedCapabilitiesManifest } from './generate-protected-capabilities.ts';

const MAX_MUTATIONS = 64;
const PROTECTED_CAPABILITIES_PATH = 'workflow/protected-capabilities.json';
const BUILT_IN_OUTPUTS = new Set([
  'packages/workflow-engine/bootstrap/built-in-engine-closure.json',
  'packages/workflow-engine/bootstrap/built-in-engine-closure-pin.ts',
]);
const HARNESS_BOOTSTRAP_OUTPUTS = new Set([
  'packages/workflow-engine/bootstrap/harness-bootstrap-dependency-closure.json',
  'packages/workflow-engine/bootstrap/harness-bootstrap-runtime-closure-pin.ts',
]);
const HARNESS_BOOTSTRAP_RUNTIME_ROOT =
  'packages/workflow-engine/bootstrap/recovery-runtime';
const ABSENT_BEFORE_DIGEST = sha256(
  canonicalJson({
    kind: 'workflow.authority-remap-absent.v1',
    side: 'before',
  }),
);
const ABSENT_AFTER_DIGEST = sha256(
  canonicalJson({
    kind: 'workflow.authority-remap-absent.v1',
    side: 'after',
  }),
);

type AuthorityRemapRequest = Parameters<typeof projectAuthorityRemap>[0];

export type AuthorityRemapMaterializationRequest = AuthorityRemapRequest &
  Readonly<{
    expectedRegenerationDescriptorDigest: `sha256:${string}`;
  }>;

type AuthorityRemapMutation = AuthorityRemapPlanIntent['mutations'][number];
type ReadyAuthorityRemapProjection = Extract<
  AuthorityRemapProjection,
  { status: 'ready' }
>;

/**
 * Materialize generator-owned consequences of one already-proven mechanical
 * move in an isolated checkout. This function never prepares, applies, signs,
 * stages, or otherwise mutates authority state in the caller repository.
 */
export async function materializeAuthorityRemap(
  request: AuthorityRemapMaterializationRequest,
): Promise<ReadyAuthorityRemapProjection> {
  const input = Object.freeze({
    repositoryRoot: fs.realpathSync(request.repositoryRoot),
    baseCommit: request.baseCommit,
    moveCommit: request.moveCommit,
    materializationCommit: request.materializationCommit ?? request.moveCommit,
    renamePairs: Object.freeze(
      request.renamePairs.map(({ from, to }) => Object.freeze({ from, to })),
    ),
    authorityPlan: Object.freeze({
      changeId: request.authorityPlan.changeId,
      taskId: request.authorityPlan.taskId,
      profileId: request.authorityPlan.profileId,
      reason: request.authorityPlan.reason,
      message: request.authorityPlan.message,
    }),
    expectedRegenerationDescriptorDigest:
      request.expectedRegenerationDescriptorDigest,
  });
  const repositoryRoot = input.repositoryRoot;
  const projectionRequest: AuthorityRemapRequest = {
    repositoryRoot,
    baseCommit: input.baseCommit,
    moveCommit: input.moveCommit,
    materializationCommit: input.materializationCommit,
    renamePairs: input.renamePairs,
    authorityPlan: input.authorityPlan,
  };

  const pending = projectAuthorityRemap(projectionRequest);
  if (pending.status !== 'requires-regeneration') {
    throw remapInvalid(
      'Authority remap materialization requires an exact pending regeneration descriptor.',
    );
  }
  assertRegenerationDescriptor(
    pending.regeneration,
    input.expectedRegenerationDescriptorDigest,
  );
  assertNoTrackedGitAttributes(repositoryRoot, input.baseCommit);
  assertNoTrackedGitAttributes(repositoryRoot, input.moveCommit);
  assertNoTrackedGitAttributes(repositoryRoot, input.materializationCommit);
  assertCallerState(repositoryRoot, input.materializationCommit);

  const pathRoles = projectAuthorityRemapPathRoles(projectionRequest);
  const checks = projectAuthorityRemapChecks(projectionRequest);
  const guards = projectAuthorityRemapGuards(projectionRequest);
  const maintainerPolicy =
    projectAuthorityRemapMaintainerPolicy(projectionRequest);
  const profiles = projectAuthorityRemapProfiles(projectionRequest);
  const baseMutations = [
    ...(pathRoles.mutation === null ? [] : [pathRoles.mutation]),
    ...(checks.mutation === null ? [] : [checks.mutation]),
    ...guards.mutations,
    ...(maintainerPolicy.mutation === null ? [] : [maintainerPolicy.mutation]),
    ...(profiles.mutation === null ? [] : [profiles.mutation]),
  ].sort((left, right) => comparePaths(left.path, right.path));
  assertUniquePaths(baseMutations.map(({ path: filePath }) => filePath));

  const temporaryRoot = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'authority-remap-materializer-'),
  );
  fs.chmodSync(temporaryRoot, 0o700);
  const isolatedRepository = path.join(temporaryRoot, 'repository');

  try {
    clonePinnedRepository(repositoryRoot, isolatedRepository);
    checkoutPinnedCommit(
      isolatedRepository,
      input.baseCommit,
      pending.manifest.baseTree,
    );
    await assertPinnedBaseGeneratedArtifactsCurrent(
      isolatedRepository,
      pending.regeneration.steps,
    );
    checkoutPinnedCommit(
      isolatedRepository,
      input.materializationCommit,
      pending.manifest.materializationTree,
    );
    for (const mutation of baseMutations) {
      applyProjectedTextMutation(isolatedRepository, mutation);
    }
    projectProtectedCapabilityPaths(isolatedRepository, pathRoles.proof.moves);

    const generatedOutputPaths = new Set<string>();
    for (const step of pending.regeneration.steps) {
      if (step === 'built-in-engine-closure') {
        generateBuiltInEngineClosure(isolatedRepository, '--write');
        for (const output of BUILT_IN_OUTPUTS) {
          generatedOutputPaths.add(output);
        }
      } else if (step === 'harness-bootstrap-runtime') {
        generateHarnessBootstrapRuntime(isolatedRepository, '--write');
        for (const output of listHarnessBootstrapOutputPaths(
          isolatedRepository,
        )) {
          generatedOutputPaths.add(output);
        }
      } else if (step === 'protected-capabilities') {
        assertGeneratedOutputsNotIgnored(
          isolatedRepository,
          generatedOutputPaths,
        );
        await generateProtectedCapabilitiesManifest(
          isolatedRepository,
          '--write',
        );
        generatedOutputPaths.add(PROTECTED_CAPABILITIES_PATH);
      } else {
        const exhaustive: never = step;
        throw remapInvalid(
          `Unsupported authority remap regeneration step ${String(exhaustive)}.`,
        );
      }
    }

    assertGeneratedOutputsNotIgnored(isolatedRepository, generatedOutputPaths);
    runGitBuffer(isolatedRepository, ['add', '-A', '--']);
    const mutations = collectStagedTextMutations(
      isolatedRepository,
      input.materializationCommit,
    ).sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
    assertAllowedFinalMutations(
      mutations,
      baseMutations.map(({ path: filePath }) => filePath),
      pending.regeneration.steps,
    );
    assertPinnedProfileAllowsFinalMutations(
      isolatedRepository,
      input.baseCommit,
      input.authorityPlan.profileId,
      mutations,
    );
    if (mutations.length === 0) {
      throw remapInvalid(
        'Authority remap regeneration produced no exact authority-plan mutation.',
      );
    }

    const intent = Object.freeze({
      schemaVersion: 1 as const,
      kind: 'authority-plan-intent.v1' as const,
      ...input.authorityPlan,
      mutations: Object.freeze(
        mutations.map((mutation) => Object.freeze({ ...mutation })),
      ),
      externalEffects: Object.freeze([]) as readonly [],
      evidenceWaivers: Object.freeze([]) as readonly [],
    });
    try {
      parseAuthorityPlanIntent(intent);
    } catch {
      throw remapInvalid(
        'Generated authority remap intent does not satisfy the landed authority-plan parser.',
      );
    }
    const intentDigest = sha256(canonicalJson(intent));
    const projections = mutations.map((mutation) =>
      Object.freeze({
        path: mutation.path,
        beforeSha256:
          mutation.expectedBeforeSha256 === null
            ? ABSENT_BEFORE_DIGEST
            : (`sha256:${mutation.expectedBeforeSha256}` as const),
        afterSha256:
          mutation.content === null
            ? ABSENT_AFTER_DIGEST
            : sha256(mutation.content),
      }),
    );
    const manifestIdentity = {
      schemaVersion: 1 as const,
      kind: 'workflow.authority-remap-manifest.v1' as const,
      baseCommit: pending.manifest.baseCommit,
      baseTree: pending.manifest.baseTree,
      moveCommit: pending.manifest.moveCommit,
      moveTree: pending.manifest.moveTree,
      materializationCommit: pending.manifest.materializationCommit,
      materializationTree: pending.manifest.materializationTree,
      mechanicalProofDigest: pending.manifest.mechanicalProofDigest,
      moves: pending.manifest.moves,
      projections: Object.freeze(projections),
      regenerationDescriptorDigest: pending.regeneration.descriptorDigest,
      authorityPlanIntentDigest: intentDigest,
    } satisfies Omit<AuthorityRemapManifestV1, 'manifestDigest'>;
    const manifest = Object.freeze({
      ...manifestIdentity,
      manifestDigest: sha256(canonicalJson(manifestIdentity)),
    });

    assertCallerState(repositoryRoot, input.materializationCommit);
    return Object.freeze({
      status: 'ready' as const,
      manifest,
      intent,
      regeneration: null,
    });
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function listHarnessBootstrapOutputPaths(repositoryRoot: string): string[] {
  const runtimeRoot = path.join(repositoryRoot, HARNESS_BOOTSTRAP_RUNTIME_ROOT);
  const rootStats = fs.lstatSync(runtimeRoot, { throwIfNoEntry: false });
  if (
    rootStats === undefined ||
    !rootStats.isDirectory() ||
    rootStats.isSymbolicLink() ||
    fs.realpathSync(runtimeRoot) !== runtimeRoot
  ) {
    throw remapInvalid(
      'Generated harness-bootstrap recovery runtime is missing or unsafe.',
    );
  }
  const outputs = [...HARNESS_BOOTSTRAP_OUTPUTS];
  const visit = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const candidate = path.join(directory, name);
      const stats = fs.lstatSync(candidate);
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        visit(candidate);
        continue;
      }
      if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
        throw remapInvalid(
          'Generated harness-bootstrap recovery runtime contains an unsafe entry.',
        );
      }
      const relative = path
        .relative(runtimeRoot, candidate)
        .split(path.sep)
        .join('/');
      const output = `${HARNESS_BOOTSTRAP_RUNTIME_ROOT}/${relative}`;
      if (normalizeExactRepositoryPath(output) !== output) {
        throw remapInvalid(
          'Generated harness-bootstrap recovery runtime contains an unsafe path.',
        );
      }
      outputs.push(output);
    }
  };
  visit(runtimeRoot);
  if (outputs.length === HARNESS_BOOTSTRAP_OUTPUTS.size) {
    throw remapInvalid(
      'Generated harness-bootstrap recovery runtime is empty.',
    );
  }
  outputs.sort(comparePaths);
  assertUniquePaths(outputs);
  return outputs;
}

function assertGeneratedOutputsNotIgnored(
  repositoryRoot: string,
  outputPaths: ReadonlySet<string>,
): void {
  if (outputPaths.size === 0) return;
  const cachedPaths = new Set(
    splitNul(
      runGitBuffer(repositoryRoot, ['ls-files', '--cached', '-z', '--']),
    ).map((entry) => {
      const filePath = decodeText(entry, 'Git cached path');
      if (normalizeExactRepositoryPath(filePath) !== filePath) {
        throw remapInvalid('Git returned an unsafe cached path.');
      }
      return filePath;
    }),
  );
  const paths = [...outputPaths]
    .filter((filePath) => !cachedPaths.has(filePath))
    .sort(comparePaths);
  if (paths.length === 0) return;
  assertUniquePaths(paths);
  const output = runGitBuffer(
    repositoryRoot,
    [
      'check-ignore',
      '--no-index',
      '--verbose',
      '--non-matching',
      '-z',
      '--stdin',
    ],
    {
      input: Buffer.from(`${paths.join('\0')}\0`, 'utf8'),
      // check-ignore returns 1 when every --non-matching record is negative;
      // the exact four-field record count below still fails closed on errors.
      allowFailure: true,
    },
  );
  const fields = splitNulFields(output);
  if (fields.length !== paths.length * 4) {
    throw remapInvalid(
      'Git returned malformed generated-output ignore evidence.',
    );
  }
  for (let index = 0; index < paths.length; index += 1) {
    const offset = index * 4;
    const source = decodeText(fields[offset]!, 'Git ignore source');
    const line = decodeText(fields[offset + 1]!, 'Git ignore line');
    const pattern = decodeText(fields[offset + 2]!, 'Git ignore pattern');
    const observedPath = decodeText(
      fields[offset + 3]!,
      'Git ignored output path',
    );
    const expectedPath = paths[index]!;
    if (observedPath !== expectedPath) {
      throw remapInvalid(
        'Git returned mismatched generated-output ignore evidence.',
      );
    }
    const matched = source !== '' || line !== '' || pattern !== '';
    if (matched && (source === '' || line === '' || pattern === '')) {
      throw remapInvalid(
        'Git returned incomplete generated-output ignore evidence.',
      );
    }
    if (matched && !pattern.startsWith('!')) {
      throw remapInvalid(
        `Generated authority remap output ${expectedPath} is hidden by Git ignore rules.`,
      );
    }
  }
}

function assertCallerState(repositoryRoot: string, moveCommit: string): void {
  assertNoCallerGitAttributeConfiguration(repositoryRoot);
  const hiddenIndexEntries = splitNul(
    runGitBuffer(repositoryRoot, ['ls-files', '-v', '-z', '--']),
  )
    .map((entry) => decodeText(entry, 'Git index flag entry'))
    .filter((entry) => {
      const tag = entry[0];
      return tag === 'S' || (tag !== undefined && tag >= 'a' && tag <= 'z');
    });
  if (hiddenIndexEntries.length > 0) {
    throw remapInvalid(
      'Authority remap materialization rejects caller hidden index flags.',
    );
  }
  const head = runGitBuffer(repositoryRoot, ['rev-parse', '--verify', 'HEAD'])
    .toString('ascii')
    .trim();
  if (head !== moveCommit) {
    throw remapInvalid(
      'Authority remap materialization requires caller HEAD to equal the exact move commit.',
    );
  }
  const status = runGitBuffer(repositoryRoot, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--ignore-submodules=none',
  ]);
  if (status.length !== 0) {
    throw remapInvalid(
      'Authority remap materialization requires a clean caller index and worktree.',
    );
  }
}

function assertNoCallerGitAttributeConfiguration(repositoryRoot: string): void {
  const keys = splitNul(
    runGitBuffer(repositoryRoot, [
      'config',
      '--null',
      '--name-only',
      '--list',
      '--includes',
    ]),
  ).map((entry) => decodeText(entry, 'Git configuration key').toLowerCase());
  if (
    keys.some(
      (key) =>
        key.startsWith('filter.') ||
        key === 'core.attributesfile' ||
        key === 'core.autocrlf' ||
        key === 'core.eol' ||
        key === 'core.checkroundtripencoding',
    )
  ) {
    throw remapInvalid(
      'Authority remap materialization rejects caller Git attribute or filter configuration.',
    );
  }
  const informationAttributesValue = runGitBuffer(repositoryRoot, [
    'rev-parse',
    '--git-path',
    'info/attributes',
  ])
    .toString('utf8')
    .trim();
  const informationAttributes = path.isAbsolute(informationAttributesValue)
    ? informationAttributesValue
    : path.resolve(repositoryRoot, informationAttributesValue);
  const stats = fs.lstatSync(informationAttributes, { throwIfNoEntry: false });
  if (
    stats !== undefined &&
    (!stats.isFile() ||
      stats.isSymbolicLink() ||
      stats.nlink !== 1 ||
      stats.size !== 0)
  ) {
    throw remapInvalid(
      'Authority remap materialization rejects caller info attributes.',
    );
  }
}

function assertRegenerationDescriptor(
  descriptor: Exclude<AuthorityRemapProjection['regeneration'], null>,
  expectedDigest: string,
): void {
  const identity = {
    schemaVersion: descriptor.schemaVersion,
    kind: descriptor.kind,
    mechanicalProofDigest: descriptor.mechanicalProofDigest,
    moveTree: descriptor.moveTree,
    materializationCommit: descriptor.materializationCommit,
    materializationTree: descriptor.materializationTree,
    affectedMoves: descriptor.affectedMoves,
    steps: descriptor.steps,
  };
  const recomputed = sha256(canonicalJson(identity));
  if (
    expectedDigest !== descriptor.descriptorDigest ||
    recomputed !== descriptor.descriptorDigest
  ) {
    throw remapInvalid(
      'Authority remap regeneration descriptor does not match the exact caller handoff.',
    );
  }
}

function assertNoTrackedGitAttributes(
  repositoryRoot: string,
  commit: string,
): void {
  const paths = splitNul(
    runGitBuffer(repositoryRoot, [
      'ls-tree',
      '-r',
      '--name-only',
      '-z',
      commit,
      '--',
    ]),
  );
  for (const encoded of paths) {
    const filePath = decodeText(encoded, 'Pinned Git tree path');
    if (filePath === '.gitattributes' || filePath.endsWith('/.gitattributes')) {
      throw remapInvalid(
        'Authority remap materialization rejects tracked .gitattributes because worktree transforms cannot prove pinned blob identity.',
      );
    }
  }
}

function clonePinnedRepository(
  sourceRepository: string,
  targetRepository: string,
): void {
  runGitBuffer(path.dirname(targetRepository), [
    '-c',
    'core.hooksPath=/dev/null',
    'clone',
    '--quiet',
    '--no-local',
    '--no-checkout',
    '--',
    sourceRepository,
    targetRepository,
  ]);
  const gitDirectoryValue = runGitBuffer(targetRepository, [
    'rev-parse',
    '--git-dir',
  ])
    .toString('utf8')
    .trim();
  const gitDirectory = path.isAbsolute(gitDirectoryValue)
    ? gitDirectoryValue
    : path.resolve(targetRepository, gitDirectoryValue);
  if (
    fs.lstatSync(path.join(gitDirectory, 'objects/info/alternates'), {
      throwIfNoEntry: false,
    }) !== undefined
  ) {
    throw remapInvalid(
      'Isolated authority remap clone must not depend on caller object alternates.',
    );
  }
}

function checkoutPinnedCommit(
  targetRepository: string,
  commit: string,
  expectedTree: string,
): void {
  runGitBuffer(targetRepository, [
    '-c',
    'core.hooksPath=/dev/null',
    'checkout',
    '--quiet',
    '--detach',
    '--force',
    commit,
    '--',
  ]);
  const head = runGitBuffer(targetRepository, ['rev-parse', '--verify', 'HEAD'])
    .toString('ascii')
    .trim();
  if (head !== commit) {
    throw remapInvalid('Isolated authority remap checkout is not pinned.');
  }
  const tree = runGitBuffer(targetRepository, [
    'rev-parse',
    '--verify',
    'HEAD^{tree}',
  ])
    .toString('ascii')
    .trim();
  if (tree !== expectedTree) {
    throw remapInvalid(
      'Isolated authority remap checkout tree does not match the pinned descriptor.',
    );
  }
}

async function assertPinnedBaseGeneratedArtifactsCurrent(
  repositoryRoot: string,
  steps: readonly (
    | 'built-in-engine-closure'
    | 'harness-bootstrap-runtime'
    | 'protected-capabilities'
  )[],
): Promise<void> {
  try {
    for (const step of steps) {
      if (step === 'built-in-engine-closure') {
        generateBuiltInEngineClosure(repositoryRoot, '--check');
      } else if (step === 'harness-bootstrap-runtime') {
        generateHarnessBootstrapRuntime(repositoryRoot, '--check');
      } else if (step === 'protected-capabilities') {
        await generateProtectedCapabilitiesManifest(repositoryRoot, '--check');
      } else {
        const exhaustive: never = step;
        throw new Error(`Unsupported regeneration step ${String(exhaustive)}.`);
      }
    }
  } catch {
    throw remapInvalid(
      'Authority remap pinned base generated artifacts are stale.',
    );
  }
}

function applyProjectedTextMutation(
  repositoryRoot: string,
  mutation: {
    path: string;
    expectedBeforeSha256: string;
    content: string;
  },
): void {
  const normalized = normalizeExactRepositoryPath(mutation.path);
  if (normalized !== mutation.path) {
    throw remapInvalid('Authority remap projection contains an unsafe path.');
  }
  const target = path.join(repositoryRoot, ...normalized.split('/'));
  const stats = fs.lstatSync(target, { throwIfNoEntry: false });
  if (
    stats === undefined ||
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1
  ) {
    throw remapInvalid(
      `Authority remap projection target ${normalized} is not safe regular text.`,
    );
  }
  const before = fs.readFileSync(target);
  if (sha256Hex(before) !== mutation.expectedBeforeSha256) {
    throw remapInvalid(
      `Authority remap projection target ${normalized} is stale.`,
    );
  }
  decodeText(before, normalized);
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, mutation.content, { mode: stats.mode & 0o777 });
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function projectProtectedCapabilityPaths(
  repositoryRoot: string,
  moves: readonly Readonly<{ from: string; to: string }>[],
): void {
  const manifestPath = path.join(repositoryRoot, PROTECTED_CAPABILITIES_PATH);
  const before = readSafeRegularFile(manifestPath, PROTECTED_CAPABILITIES_PATH);
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeText(before, PROTECTED_CAPABILITIES_PATH));
  } catch {
    throw remapInvalid(`${PROTECTED_CAPABILITIES_PATH} is not valid JSON.`);
  }
  let source: ProtectedCapabilitiesManifestSource;
  try {
    source = parseProtectedCapabilitiesManifestSource(parsed);
  } catch {
    throw remapInvalid(
      `${PROTECTED_CAPABILITIES_PATH} is not a valid landed manifest.`,
    );
  }

  let changed = false;
  const entries = source.entries.map((entry) => {
    let entrypoints = [...entry.entrypoints];
    let dependencies = [...entry.dependencies];
    for (const move of moves) {
      const nextEntrypoints = projectProtectedPathSet(
        entrypoints,
        move.from,
        move.to,
      );
      const nextDependencies = projectProtectedPathSet(
        dependencies,
        move.from,
        move.to,
      );
      changed ||= !sameStrings(entrypoints, nextEntrypoints);
      changed ||= !sameStrings(dependencies, nextDependencies);
      entrypoints = nextEntrypoints;
      dependencies = nextDependencies;
    }
    return { ...entry, entrypoints, dependencies };
  });
  const projected = { ...source, entries };
  try {
    parseProtectedCapabilitiesManifestSource(projected);
  } catch {
    throw remapInvalid(
      `Projected ${PROTECTED_CAPABILITIES_PATH} does not satisfy the landed parser.`,
    );
  }
  if (changed) {
    fs.writeFileSync(manifestPath, `${JSON.stringify(projected, null, 2)}\n`, {
      mode: 0o644,
    });
  }
}

function projectProtectedPathSet(
  paths: readonly string[],
  from: string,
  to: string,
): string[] {
  let exactMoved = false;
  let broadCoveredSource = false;
  const projected = paths.map((candidate) => {
    if (candidate === from) {
      exactMoved = true;
      return to;
    }
    if (matchesAllowedPath(from, candidate)) broadCoveredSource = true;
    return candidate;
  });
  if (
    broadCoveredSource &&
    !projected.some((candidate) => matchesAllowedPath(to, candidate))
  ) {
    projected.push(to);
  }
  if (exactMoved && !projected.includes(to)) projected.push(to);
  return [...new Set(projected)].sort(comparePaths);
}

function collectStagedTextMutations(
  repositoryRoot: string,
  moveCommit: string,
): AuthorityRemapMutation[] {
  const tokens = splitNul(
    runGitBuffer(repositoryRoot, [
      'diff',
      '--cached',
      '--name-status',
      '--no-renames',
      '-z',
      moveCommit,
      '--',
    ]),
  );
  if (tokens.length % 2 !== 0) {
    throw remapInvalid('Generated authority remap diff is malformed.');
  }
  const changes: Array<{ status: 'A' | 'M' | 'D'; path: string }> = [];
  for (let index = 0; index < tokens.length; index += 2) {
    const status = decodeText(tokens[index]!, 'Git diff status');
    const filePath = decodeText(tokens[index + 1]!, 'Git diff path');
    if (status !== 'A' && status !== 'M' && status !== 'D') {
      throw remapInvalid(
        `Generated authority remap contains unsupported Git status ${status}.`,
      );
    }
    let normalized: string;
    try {
      normalized = normalizeExactRepositoryPath(filePath);
    } catch {
      throw remapInvalid('Generated authority remap contains an unsafe path.');
    }
    if (normalized !== filePath) {
      throw remapInvalid(
        'Generated authority remap contains a non-normalized path.',
      );
    }
    changes.push({ status, path: filePath });
  }
  changes.sort((left, right) => comparePaths(left.path, right.path));
  assertUniquePaths(changes.map(({ path: filePath }) => filePath));
  if (changes.length > MAX_MUTATIONS) {
    throw remapInvalid(
      `Generated authority remap exceeds the ${MAX_MUTATIONS}-file materialization limit.`,
    );
  }

  return changes.map(({ status, path: filePath }) => {
    const beforeEntry = readTreeEntry(repositoryRoot, moveCommit, filePath);
    const afterEntry = readIndexEntry(repositoryRoot, filePath);
    if (status === 'A') {
      if (beforeEntry !== null || afterEntry?.mode !== '100644') {
        throw remapInvalid(
          `Generated addition ${filePath} is not a new 100644 text file.`,
        );
      }
    } else if (status === 'D') {
      if (beforeEntry === null || afterEntry !== null) {
        throw remapInvalid(`Generated deletion ${filePath} is malformed.`);
      }
    } else if (
      beforeEntry === null ||
      afterEntry === null ||
      beforeEntry.mode !== afterEntry.mode
    ) {
      throw remapInvalid(
        `Generated mutation ${filePath} changes or lacks its Git mode.`,
      );
    }
    const before =
      status === 'A'
        ? null
        : runGitBuffer(repositoryRoot, ['show', `${moveCommit}:${filePath}`]);
    const after =
      status === 'D'
        ? null
        : runGitBuffer(repositoryRoot, ['show', `:${filePath}`]);
    const beforeText =
      before === null ? null : decodeText(before, `${filePath} before`);
    const afterText =
      after === null ? null : decodeText(after, `${filePath} after`);
    return Object.freeze({
      path: filePath,
      expectedBeforeSha256: before === null ? null : sha256Hex(before),
      content: afterText,
    });
  });
}

function readTreeEntry(
  repositoryRoot: string,
  commit: string,
  filePath: string,
): { mode: string; objectId: string } | null {
  const output = runGitBuffer(repositoryRoot, [
    'ls-tree',
    '-z',
    commit,
    '--',
    filePath,
  ]);
  if (output.length === 0) return null;
  const records = splitNul(output);
  if (records.length !== 1) {
    throw remapInvalid(`Pinned tree entry ${filePath} is ambiguous.`);
  }
  const record = decodeText(records[0]!, `${filePath} tree entry`);
  const tab = record.indexOf('\t');
  const metadata = tab === -1 ? [] : record.slice(0, tab).split(' ');
  const observedPath = tab === -1 ? '' : record.slice(tab + 1);
  const [mode, type, objectId] = metadata;
  if (
    metadata.length !== 3 ||
    observedPath !== filePath ||
    type !== 'blob' ||
    mode === undefined ||
    objectId === undefined
  ) {
    throw remapInvalid(`Pinned tree entry ${filePath} is unsupported.`);
  }
  return { mode, objectId };
}

function readIndexEntry(
  repositoryRoot: string,
  filePath: string,
): { mode: string; objectId: string } | null {
  const output = runGitBuffer(repositoryRoot, [
    'ls-files',
    '--stage',
    '-z',
    '--',
    filePath,
  ]);
  if (output.length === 0) return null;
  const records = splitNul(output);
  if (records.length !== 1) {
    throw remapInvalid(`Generated index entry ${filePath} is ambiguous.`);
  }
  const record = decodeText(records[0]!, `${filePath} index entry`);
  const tab = record.indexOf('\t');
  const metadata = tab === -1 ? [] : record.slice(0, tab).split(' ');
  const observedPath = tab === -1 ? '' : record.slice(tab + 1);
  const [mode, objectId, stage] = metadata;
  if (
    metadata.length !== 3 ||
    observedPath !== filePath ||
    stage !== '0' ||
    mode === undefined ||
    objectId === undefined
  ) {
    throw remapInvalid(`Generated index entry ${filePath} is unsupported.`);
  }
  return { mode, objectId };
}

function assertAllowedFinalMutations(
  mutations: readonly AuthorityRemapMutation[],
  baseAuthorityPaths: readonly string[],
  steps: readonly (
    | 'built-in-engine-closure'
    | 'harness-bootstrap-runtime'
    | 'protected-capabilities'
  )[],
): void {
  const base = new Set(baseAuthorityPaths);
  const enabled = new Set(steps);
  for (const mutation of mutations) {
    const allowed =
      base.has(mutation.path) ||
      (enabled.has('built-in-engine-closure') &&
        BUILT_IN_OUTPUTS.has(mutation.path)) ||
      (enabled.has('harness-bootstrap-runtime') &&
        (HARNESS_BOOTSTRAP_OUTPUTS.has(mutation.path) ||
          mutation.path.startsWith(`${HARNESS_BOOTSTRAP_RUNTIME_ROOT}/`))) ||
      (enabled.has('protected-capabilities') &&
        mutation.path === PROTECTED_CAPABILITIES_PATH);
    if (!allowed) {
      throw remapInvalid(
        `Generated authority remap changed non-owned path ${mutation.path}.`,
      );
    }
  }
  const observed = new Set(mutations.map(({ path: filePath }) => filePath));
  for (const required of base) {
    if (!observed.has(required)) {
      throw remapInvalid(
        `Generated authority remap lost base authority projection ${required}.`,
      );
    }
  }
}

function assertPinnedProfileAllowsFinalMutations(
  repositoryRoot: string,
  baseCommit: string,
  profileId: string,
  mutations: readonly AuthorityRemapMutation[],
): void {
  let profile: ReturnType<typeof loadCapabilityProfileFromTrustBase>;
  try {
    profile = loadCapabilityProfileFromTrustBase(
      repositoryRoot,
      baseCommit,
      profileId,
    );
  } catch {
    throw remapInvalid(
      `Authority remap profile ${profileId} is absent or invalid in the pinned trust base.`,
    );
  }
  if (mutations.length > profile.constraints.maximumFiles) {
    throw remapInvalid(
      `Authority remap exceeds profile ${profileId} file limit.`,
    );
  }
  for (const mutation of mutations) {
    const role = classifyFileRole(profile, mutation.path);
    if (role === undefined || role === 'forbidden') {
      throw remapInvalid(
        `Authority remap profile ${profileId} cannot authorize ${mutation.path}.`,
      );
    }
  }
}

function readSafeRegularFile(filePath: string, label: string): Buffer {
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (
    stats === undefined ||
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1
  ) {
    throw remapInvalid(`${label} is not safe regular text.`);
  }
  return fs.readFileSync(filePath);
}

function splitNul(output: Buffer): Buffer[] {
  if (output.length === 0) return [];
  if (output[output.length - 1] !== 0) {
    throw remapInvalid('Git returned a malformed NUL-delimited record.');
  }
  const values: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== 0) continue;
    if (index === start) {
      throw remapInvalid('Git returned an empty NUL-delimited record.');
    }
    values.push(output.subarray(start, index));
    start = index + 1;
  }
  return values;
}

function splitNulFields(output: Buffer): Buffer[] {
  if (output.length === 0 || output[output.length - 1] !== 0) {
    throw remapInvalid('Git returned malformed NUL-delimited fields.');
  }
  const values: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== 0) continue;
    values.push(output.subarray(start, index));
    start = index + 1;
  }
  return values;
}

function decodeText(value: Buffer, label: string): string {
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    throw remapInvalid(`${label} is not UTF-8 text.`);
  }
  if (decoded.includes('\0')) {
    throw remapInvalid(`${label} contains a NUL byte.`);
  }
  return decoded;
}

function assertUniquePaths(paths: readonly string[]): void {
  if (new Set(paths).size !== paths.length) {
    throw remapInvalid('Authority remap mutations contain duplicate paths.');
  }
  const folded = new Set<string>();
  for (const filePath of paths) {
    const key = filePath.toLocaleLowerCase('en-US');
    if (folded.has(key)) {
      throw remapInvalid(
        'Authority remap mutations contain a case-fold path alias.',
      );
    }
    folded.add(key);
  }
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function comparePaths(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function sha256(value: string | Buffer): `sha256:${string}` {
  return `sha256:${sha256Hex(value)}`;
}

function sha256Hex(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function remapInvalid(message: string) {
  return workflowError(
    'AUTHORITY_REMAP_INVALID',
    message,
    ExitCode.verification,
  );
}
