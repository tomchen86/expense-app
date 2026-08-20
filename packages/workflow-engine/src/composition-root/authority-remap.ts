import crypto from 'node:crypto';

import { canonicalJson } from '../foundation/canonical-json/canonical-json.ts';
import { isRecord } from '../foundation/canonical-json/contract-values.ts';
import {
  ExitCode,
  WorkflowError,
  workflowError,
} from '../foundation/errors/errors.ts';
import { runGitBuffer } from '../runtime/repository-transaction/git.ts';
import {
  readPinnedTrackedTree,
  type TrackedTreeEntry,
} from '../runtime/repository-transaction/tracked-tree-reader.ts';
import {
  assertChangeId,
  assertTaskId,
  matchesAllowedPath,
  normalizeExactRepositoryPath,
  normalizePolicyPath,
} from '../runtime/session-workspace/paths.ts';
import {
  parsePathRoleRegistry,
  resolvePathRole,
  type PathRole,
} from '../modules/source/path-role-registry.ts';
import {
  parseCheckCommand,
  parseChecksConfigSource,
} from '../modules/source/check-command.ts';
import {
  classifyFileRole,
  parseCapabilityProfile,
  type CapabilityProfile,
  type FileRole,
} from '../modules/authority/maintainer-manifest.ts';
import {
  parseMaintainerPolicy,
  type MaintainerPolicy,
} from '../modules/authority/maintainer-policy.ts';
import { engineProjectionDefinitions } from '../modules/projection/engine-projection-registry.ts';
import { parseProtectedCapabilitiesManifestSource } from '../adapters/consumer/expense-app/work-registry/protected-capabilities.ts';

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_RENAME_PAIRS = 10_000;
const NUL = 0x00;
const PATH_ROLES_PATH = 'workflow/path-roles.json';
const CHECKS_PATH = 'workflow/checks.json';
const CONFIG_PATH = 'workflow/config.json';
const MAINTAINER_POLICY_PATH = 'workflow/maintainer-policy.json';
const MAINTAINER_PROFILES_PATH = 'workflow/maintainer-profiles.json';
const BUILT_IN_CLOSURE_PATH =
  'packages/workflow-engine/bootstrap/built-in-engine-closure.json';
const PROTECTED_CAPABILITIES_PATH = 'workflow/protected-capabilities.json';
const PROTECTED_CAPABILITIES_LOADER_PATH =
  'packages/workflow-engine/src/adapters/consumer/expense-app/work-registry/protected-capabilities.ts';
const ENGINE_PROJECTION_REGISTRY_PATH =
  'packages/workflow-engine/src/modules/projection/engine-projection-registry.ts';
const BOOTSTRAP_ROOT = 'packages/workflow-engine/bootstrap';
const REGENERATION_STEPS = [
  'built-in-engine-closure',
  'harness-bootstrap-runtime',
  'protected-capabilities',
] as const;
const PROFILE_PATH_FIELDS = [
  'implementationPaths',
  'evidencePaths',
  'policyPaths',
  'verificationInfrastructurePaths',
  'forbiddenPaths',
] as const;

type ProfilePathField = (typeof PROFILE_PATH_FIELDS)[number];
type AuthorityRemapRegenerationStep = (typeof REGENERATION_STEPS)[number];

export type AuthorityRemapPair = Readonly<{ from: string; to: string }>;

export type MechanicalMoveProof = Readonly<{
  schemaVersion: 1;
  kind: 'workflow.mechanical-move-proof.v1';
  baseCommit: string;
  baseTree: string;
  moveCommit: string;
  moveTree: string;
  moves: readonly Readonly<{
    from: string;
    to: string;
    objectId: string;
    mode: '100644' | '100755';
  }>[];
  proofDigest: `sha256:${string}`;
}>;

export type AuthorityRemapPathRoleProjection = Readonly<{
  proof: MechanicalMoveProof;
  roles: readonly Readonly<{
    from: string;
    to: string;
    role: PathRole;
    beforePattern: string;
    afterPattern: string;
  }>[];
  mutation: Readonly<{
    path: typeof PATH_ROLES_PATH;
    expectedBeforeSha256: string;
    content: string;
  }> | null;
}>;

export type AuthorityRemapCheckProjection = Readonly<{
  proof: MechanicalMoveProof;
  checks: readonly Readonly<{
    checkId: string;
    from: string;
    to: string;
  }>[];
  mutation: Readonly<{
    path: typeof CHECKS_PATH;
    expectedBeforeSha256: string;
    content: string;
  }> | null;
}>;

export type AuthorityRemapGuardProjection = Readonly<{
  proof: MechanicalMoveProof;
  guards: readonly Readonly<{
    path: string;
    replacements: readonly Readonly<{
      taskId: string;
      from: string;
      to: string;
    }>[];
  }>[];
  mutations: readonly Readonly<{
    path: string;
    expectedBeforeSha256: string;
    content: string;
  }>[];
}>;

export type AuthorityRemapMaintainerPolicyProjection = Readonly<{
  proof: MechanicalMoveProof;
  paths: readonly Readonly<{
    field: 'bootstrapEligiblePaths' | 'sealedImmutablePaths';
    from: string;
    to: string;
  }>[];
  mutation: Readonly<{
    path: typeof MAINTAINER_POLICY_PATH;
    expectedBeforeSha256: string;
    content: string;
  }> | null;
}>;

export type AuthorityRemapProfileProjection = Readonly<{
  proof: MechanicalMoveProof;
  profiles: readonly Readonly<{
    profileId: string;
    from: string;
    to: string;
    beforeRole: FileRole;
    afterRole: FileRole;
    changedFields: readonly ProfilePathField[];
  }>[];
  mutation: Readonly<{
    path: typeof MAINTAINER_PROFILES_PATH;
    expectedBeforeSha256: string;
    content: string;
  }> | null;
}>;

export type AuthorityRemapRegenerationDescriptor = Readonly<{
  schemaVersion: 1;
  kind: 'workflow.authority-remap-regeneration.v1';
  mechanicalProofDigest: `sha256:${string}`;
  moveTree: string;
  materializationCommit: string;
  materializationTree: string;
  affectedMoves: readonly Readonly<{ from: string; to: string }>[];
  steps: readonly AuthorityRemapRegenerationStep[];
  descriptorDigest: `sha256:${string}`;
}>;

export type AuthorityRemapManifestV1 = Readonly<{
  schemaVersion: 1;
  kind: 'workflow.authority-remap-manifest.v1';
  baseCommit: string;
  baseTree: string;
  moveCommit: string;
  moveTree: string;
  materializationCommit: string;
  materializationTree: string;
  mechanicalProofDigest: `sha256:${string}`;
  moves: readonly Readonly<{
    from: string;
    to: string;
    objectId: string;
    mode: '100644' | '100755';
    role: Readonly<{
      name: PathRole;
      beforePattern: string;
      afterPattern: string;
    }>;
  }>[];
  projections: readonly Readonly<{
    path: string;
    beforeSha256: `sha256:${string}`;
    afterSha256: `sha256:${string}`;
  }>[];
  regenerationDescriptorDigest: `sha256:${string}` | null;
  authorityPlanIntentDigest: `sha256:${string}` | null;
  manifestDigest: `sha256:${string}`;
}>;

export type AuthorityRemapProjection =
  | Readonly<{
      status: 'ready';
      manifest: AuthorityRemapManifestV1;
      intent: AuthorityRemapPlanIntent | null;
      regeneration: null;
    }>
  | Readonly<{
      status: 'requires-regeneration';
      manifest: AuthorityRemapManifestV1;
      intent: null;
      regeneration: AuthorityRemapRegenerationDescriptor;
    }>;

export type AuthorityRemapPlanIntent = Readonly<{
  schemaVersion: 1;
  kind: 'authority-plan-intent.v1';
  changeId: string;
  taskId: string;
  profileId: string;
  reason: string;
  message: string;
  mutations: readonly AuthorityRemapMutation[];
  externalEffects: readonly [];
  evidenceWaivers: readonly [];
}>;

type AuthorityRemapMutation = Readonly<{
  path: string;
  expectedBeforeSha256: string | null;
  content: string | null;
}>;

/**
 * Prove that one adjacent pinned commit is made only of the caller-declared
 * byte-identical file moves. Git rename similarity is deliberately excluded:
 * the declaration owns pairing, while the two trees own blob and mode identity.
 */
export function verifyMechanicalMovePhase(request: {
  repositoryRoot: string;
  baseCommit: string;
  moveCommit: string;
  renamePairs: readonly AuthorityRemapPair[];
}): MechanicalMoveProof {
  const { repositoryRoot, baseCommit, moveCommit } = request;
  if (
    !OBJECT_ID.test(baseCommit) ||
    !OBJECT_ID.test(moveCommit) ||
    baseCommit === moveCommit
  ) {
    throw remapInvalid(
      'Mechanical move proof requires distinct full base and move commit object IDs.',
    );
  }
  const renamePairs = normalizeRenamePairs(request.renamePairs);
  assertDirectChild(repositoryRoot, baseCommit, moveCommit);

  const baseTree = resolveCommitTree(repositoryRoot, baseCommit);
  const moveTree = resolveCommitTree(repositoryRoot, moveCommit);
  const baseSnapshot = readPinnedTrackedTree({
    repositoryRoot,
    treeOid: baseTree,
  });
  const moveSnapshot = readPinnedTrackedTree({
    repositoryRoot,
    treeOid: moveTree,
  });
  const baseEntries = entriesByUtf8Path(baseSnapshot.entries);
  const moveEntries = entriesByUtf8Path(moveSnapshot.entries);

  assertPureDeclaredDiff(repositoryRoot, baseCommit, moveCommit, renamePairs);

  const moves = renamePairs.map(({ from, to }) => {
    const before = baseEntries.get(from);
    const after = moveEntries.get(to);
    if (
      before === undefined ||
      after === undefined ||
      baseEntries.has(to) ||
      moveEntries.has(from)
    ) {
      throw remapInvalid(
        `Declared move ${from} -> ${to} does not have one absent-source/absent-target tree transition.`,
      );
    }
    assertNoCaseAlias(baseEntries, from);
    assertNoCaseAlias(moveEntries, to);
    if (
      before.objectType !== 'blob' ||
      after.objectType !== 'blob' ||
      !isRegularMode(before.mode) ||
      !isRegularMode(after.mode) ||
      before.objectId !== after.objectId ||
      before.mode !== after.mode
    ) {
      throw remapInvalid(
        `Declared move ${from} -> ${to} is not byte-identical with the same Git mode.`,
      );
    }
    return Object.freeze({
      from,
      to,
      objectId: before.objectId,
      mode: before.mode,
    });
  });
  const identity = {
    schemaVersion: 1 as const,
    kind: 'workflow.mechanical-move-proof.v1' as const,
    baseCommit,
    baseTree,
    moveCommit,
    moveTree,
    moves,
  };
  return Object.freeze({
    ...identity,
    moves: Object.freeze(moves),
    proofDigest: sha256(canonicalJson(identity)),
  });
}

/**
 * Project the reviewed path-role registry over an already-proven move phase.
 * Exact source registrations are moved; a role inherited from a broad source
 * prefix is pinned exactly at the destination when its inherited role changes.
 */
export function projectAuthorityRemapPathRoles(request: {
  repositoryRoot: string;
  baseCommit: string;
  moveCommit: string;
  renamePairs: readonly AuthorityRemapPair[];
}): AuthorityRemapPathRoleProjection {
  const proof = verifyMechanicalMovePhase(request);
  const baseSnapshot = readPinnedTrackedTree({
    repositoryRoot: request.repositoryRoot,
    treeOid: proof.baseTree,
  });
  const moveSnapshot = readPinnedTrackedTree({
    repositoryRoot: request.repositoryRoot,
    treeOid: proof.moveTree,
  });
  const baseEntry = requireTrackedTextEntry(
    baseSnapshot.entries,
    PATH_ROLES_PATH,
  );
  const moveEntry = requireTrackedTextEntry(
    moveSnapshot.entries,
    PATH_ROLES_PATH,
  );
  if (
    baseEntry.objectId !== moveEntry.objectId ||
    baseEntry.mode !== moveEntry.mode
  ) {
    throw remapInvalid(
      `The move commit must not edit or move ${PATH_ROLES_PATH}.`,
    );
  }
  const beforeContent = baseEntry.content!.toString('utf8');
  let source: unknown;
  try {
    source = JSON.parse(beforeContent);
  } catch {
    throw remapInvalid(`${PATH_ROLES_PATH} is not valid JSON.`);
  }
  let baseRegistry: ReturnType<typeof parsePathRoleRegistry>;
  try {
    baseRegistry = parsePathRoleRegistry(source);
  } catch {
    throw remapInvalid(`${PATH_ROLES_PATH} is not a valid registry.`);
  }
  if (!isRecord(source) || !isRecord(source.roles)) {
    throw remapInvalid(`${PATH_ROLES_PATH} has no projectable roles.`);
  }
  const projectedRoles: Record<string, string[]> = {};
  for (const [role, patterns] of Object.entries(source.roles)) {
    if (
      !Array.isArray(patterns) ||
      !patterns.every((pattern) => typeof pattern === 'string')
    ) {
      throw remapInvalid(`${PATH_ROLES_PATH} has malformed role paths.`);
    }
    projectedRoles[role] = [...patterns];
  }

  const beforeResolutions = proof.moves.map(({ from, to }) => {
    const before = resolvePathRole(baseRegistry, from);
    if (!before.registered) {
      throw remapInvalid(`Moved path ${from} has no registered path role.`);
    }
    const exactDestinationRole = exactPatternRole(projectedRoles, to);
    if (exactDestinationRole !== null && exactDestinationRole !== before.role) {
      throw remapInvalid(
        `Moved path ${to} has a conflicting exact destination role.`,
      );
    }
    return { from, to, before };
  });

  let changed = false;
  for (const { from, to, before } of beforeResolutions) {
    for (const patterns of Object.values(projectedRoles)) {
      const withoutSource = patterns.filter((pattern) => pattern !== from);
      if (withoutSource.length !== patterns.length) changed = true;
      patterns.splice(0, patterns.length, ...withoutSource);
    }
    if (exactPatternRole(projectedRoles, to) === null) {
      const destinationRole = resolvePathRole(baseRegistry, to);
      if (!destinationRole.registered || destinationRole.role !== before.role) {
        projectedRoles[before.role]!.push(to);
        changed = true;
      }
    }
  }
  for (const patterns of Object.values(projectedRoles)) {
    patterns.sort(comparePaths);
  }

  const projectedSource = { ...source, roles: projectedRoles };
  let projectedRegistry: ReturnType<typeof parsePathRoleRegistry>;
  try {
    projectedRegistry = parsePathRoleRegistry(projectedSource);
  } catch {
    throw remapInvalid('Projected path roles are invalid.');
  }
  const roles = beforeResolutions.map(({ from, to, before }) => {
    const after = resolvePathRole(projectedRegistry, to);
    if (!after.registered || after.role !== before.role) {
      throw remapInvalid(
        `Path role continuity failed for declared move ${from} -> ${to}.`,
      );
    }
    return Object.freeze({
      from,
      to,
      role: before.role,
      beforePattern: before.pattern,
      afterPattern: after.pattern,
    });
  });
  const content = changed
    ? `${JSON.stringify(projectedSource, null, 2)}\n`
    : null;
  return Object.freeze({
    proof,
    roles: Object.freeze(roles),
    mutation:
      content === null
        ? null
        : Object.freeze({
            path: PATH_ROLES_PATH,
            expectedBeforeSha256: sha256Hex(beforeContent),
            content,
          }),
  });
}

/**
 * Rewrite only exact argv tokens in the pinned check registry and re-parse each
 * command through the code-owned command grammar. Embedded or otherwise
 * ambiguous path spellings fail closed instead of receiving substring edits.
 */
export function projectAuthorityRemapChecks(request: {
  repositoryRoot: string;
  baseCommit: string;
  moveCommit: string;
  renamePairs: readonly AuthorityRemapPair[];
}): AuthorityRemapCheckProjection {
  const proof = verifyMechanicalMovePhase(request);
  const baseSnapshot = readPinnedTrackedTree({
    repositoryRoot: request.repositoryRoot,
    treeOid: proof.baseTree,
  });
  const moveSnapshot = readPinnedTrackedTree({
    repositoryRoot: request.repositoryRoot,
    treeOid: proof.moveTree,
  });
  const baseEntry = requireTrackedTextEntry(baseSnapshot.entries, CHECKS_PATH);
  const moveEntry = requireTrackedTextEntry(moveSnapshot.entries, CHECKS_PATH);
  if (
    baseEntry.objectId !== moveEntry.objectId ||
    baseEntry.mode !== moveEntry.mode
  ) {
    throw remapInvalid(`The move commit must not edit or move ${CHECKS_PATH}.`);
  }
  const beforeContent = baseEntry.content!.toString('utf8');
  let source: unknown;
  try {
    source = JSON.parse(beforeContent);
  } catch {
    throw remapInvalid(`${CHECKS_PATH} is not valid JSON.`);
  }
  const parsedChecks = parseChecksConfigSource(source);
  if (!parsedChecks.ok || !isRecord(source)) {
    throw remapInvalid(
      `${CHECKS_PATH} has no valid projectable check registry.`,
    );
  }

  const projectedChecks: Record<string, unknown> = {};
  const replacements = new Map<
    string,
    { checkId: string; from: string; to: string }
  >();
  let changed = false;
  for (const [checkId, definition] of Object.entries(
    parsedChecks.value.checks,
  )) {
    const command = definition.command.map((part) => {
      for (const { from, to } of proof.moves) {
        if (part === from) {
          changed = true;
          replacements.set(`${checkId}\0${from}\0${to}`, {
            checkId,
            from,
            to,
          });
          return to;
        }
        if (containsEmbeddedPathReference(part, from)) {
          throw remapInvalid(
            `Check ${checkId} embeds moved path ${from} in an unsupported argv token.`,
          );
        }
      }
      return part;
    });
    if (parseCheckCommand(command) === undefined) {
      throw remapInvalid(`Projected check ${checkId} has an invalid command.`);
    }
    projectedChecks[checkId] = { ...definition, command };
  }
  const checks = [...replacements.values()].sort(
    (left, right) =>
      comparePaths(left.checkId, right.checkId) ||
      comparePaths(left.from, right.from) ||
      comparePaths(left.to, right.to),
  );
  const projectedSource = { ...source, checks: projectedChecks };
  if (!parseChecksConfigSource(projectedSource).ok) {
    throw remapInvalid(
      `${CHECKS_PATH} projection is not a valid check registry.`,
    );
  }
  const content = changed
    ? `${JSON.stringify(projectedSource, null, 2)}\n`
    : null;
  return Object.freeze({
    proof,
    checks: Object.freeze(
      checks.map((replacement) => Object.freeze(replacement)),
    ),
    mutation:
      content === null
        ? null
        : Object.freeze({
            path: CHECKS_PATH,
            expectedBeforeSha256: sha256Hex(beforeContent),
            content,
          }),
  });
}

/**
 * Project task scopes only for active, direct-child changes. Archived and dot
 * history is excluded by construction; an unexpected non-archive guard shape
 * fails closed rather than being silently treated as history.
 */
export function projectAuthorityRemapGuards(request: {
  repositoryRoot: string;
  baseCommit: string;
  moveCommit: string;
  renamePairs: readonly AuthorityRemapPair[];
}): AuthorityRemapGuardProjection {
  const proof = verifyMechanicalMovePhase(request);
  const baseSnapshot = readPinnedTrackedTree({
    repositoryRoot: request.repositoryRoot,
    treeOid: proof.baseTree,
  });
  const moveSnapshot = readPinnedTrackedTree({
    repositoryRoot: request.repositoryRoot,
    treeOid: proof.moveTree,
  });
  const configBase = requireTrackedTextEntry(baseSnapshot.entries, CONFIG_PATH);
  const configMove = requireTrackedTextEntry(moveSnapshot.entries, CONFIG_PATH);
  if (
    configBase.objectId !== configMove.objectId ||
    configBase.mode !== configMove.mode
  ) {
    throw remapInvalid(`The move commit must not edit or move ${CONFIG_PATH}.`);
  }
  const changeRoot = parseChangeRoot(configBase.content!.toString('utf8'));
  const baseGuards = activeGuardEntries(baseSnapshot.entries, changeRoot);
  const moveGuards = activeGuardEntries(moveSnapshot.entries, changeRoot);
  if (!sameStrings([...baseGuards.keys()], [...moveGuards.keys()])) {
    throw remapInvalid(
      'The move commit must not add, remove, or move an active guard.',
    );
  }

  const guards: Array<{
    path: string;
    replacements: Array<{ taskId: string; from: string; to: string }>;
  }> = [];
  const mutations: Array<{
    path: string;
    expectedBeforeSha256: string;
    content: string;
  }> = [];
  for (const [guardPath, baseEntry] of baseGuards) {
    const moveEntry = moveGuards.get(guardPath)!;
    if (
      baseEntry.objectId !== moveEntry.objectId ||
      baseEntry.mode !== moveEntry.mode
    ) {
      throw remapInvalid(`The move commit edits active guard ${guardPath}.`);
    }
    const beforeContent = baseEntry.content!.toString('utf8');
    const source = parseGuardSource(beforeContent, guardPath, changeRoot);
    const tasks: Record<string, unknown> = {};
    const replacements = new Map<
      string,
      { taskId: string; from: string; to: string }
    >();
    let changed = false;
    for (const [taskId, policy] of Object.entries(source.tasks)) {
      const allowedPaths = [...policy.allowedPaths];
      for (const { from, to } of proof.moves) {
        const coveredBefore = policy.allowedPaths.some((allowedPath) =>
          matchesAllowedPath(from, allowedPath),
        );
        if (!coveredBefore) continue;
        let pairChanged = false;
        for (let index = 0; index < allowedPaths.length; index += 1) {
          if (allowedPaths[index] === from) {
            allowedPaths[index] = to;
            changed = true;
            pairChanged = true;
          }
        }
        if (
          !allowedPaths.some((allowedPath) =>
            matchesAllowedPath(to, allowedPath),
          )
        ) {
          allowedPaths.push(to);
          changed = true;
          pairChanged = true;
        }
        if (pairChanged) {
          replacements.set(`${taskId}\0${from}\0${to}`, { taskId, from, to });
        }
      }
      const uniqueAllowedPaths = [...new Set(allowedPaths)];
      for (const allowedPath of uniqueAllowedPaths) {
        try {
          normalizePolicyPath(allowedPath);
        } catch {
          throw remapInvalid(
            `Projected guard ${guardPath} has an unsafe allowed path.`,
          );
        }
      }
      tasks[taskId] = { ...policy.raw, allowedPaths: uniqueAllowedPaths };
    }
    if (!changed) continue;
    const projectedSource = { ...source.raw, tasks };
    const content = `${JSON.stringify(projectedSource, null, 2)}\n`;
    guards.push({
      path: guardPath,
      replacements: [...replacements.values()].sort(
        (left, right) =>
          comparePaths(left.taskId, right.taskId) ||
          comparePaths(left.from, right.from) ||
          comparePaths(left.to, right.to),
      ),
    });
    mutations.push({
      path: guardPath,
      expectedBeforeSha256: sha256Hex(beforeContent),
      content,
    });
  }
  guards.sort((left, right) => comparePaths(left.path, right.path));
  mutations.sort((left, right) => comparePaths(left.path, right.path));
  return Object.freeze({
    proof,
    guards: Object.freeze(
      guards.map((guard) =>
        Object.freeze({
          path: guard.path,
          replacements: Object.freeze(
            guard.replacements.map((replacement) => Object.freeze(replacement)),
          ),
        }),
      ),
    ),
    mutations: Object.freeze(
      mutations.map((mutation) => Object.freeze(mutation)),
    ),
  });
}

/**
 * Move the two maintainer-policy path sets with their governed files. Exact
 * entries follow the blob; broad entries stay in place and gain one exact
 * destination pin only when the destination leaves that broad scope.
 */
export function projectAuthorityRemapMaintainerPolicy(request: {
  repositoryRoot: string;
  baseCommit: string;
  moveCommit: string;
  renamePairs: readonly AuthorityRemapPair[];
}): AuthorityRemapMaintainerPolicyProjection {
  const proof = verifyMechanicalMovePhase(request);
  const { beforeContent } = readUnchangedAuthorityText(
    request.repositoryRoot,
    proof,
    MAINTAINER_POLICY_PATH,
  );
  let source: unknown;
  try {
    source = JSON.parse(beforeContent);
  } catch {
    throw remapInvalid(`${MAINTAINER_POLICY_PATH} is not valid JSON.`);
  }
  let before: MaintainerPolicy;
  try {
    before = parseMaintainerPolicy(source);
  } catch {
    throw remapInvalid(`${MAINTAINER_POLICY_PATH} is not a valid policy.`);
  }
  if (!isRecord(source)) {
    throw remapInvalid(`${MAINTAINER_POLICY_PATH} is not projectable.`);
  }

  const projected = {
    ...source,
    bootstrapEligiblePaths: [...before.bootstrapEligiblePaths],
    sealedImmutablePaths: [...before.sealedImmutablePaths],
  };
  const paths: Array<{
    field: 'bootstrapEligiblePaths' | 'sealedImmutablePaths';
    from: string;
    to: string;
  }> = [];
  let changed = false;
  for (const move of proof.moves) {
    for (const field of [
      'bootstrapEligiblePaths',
      'sealedImmutablePaths',
    ] as const) {
      const result = projectPathSet(projected[field], move.from, move.to);
      projected[field] = result.paths;
      if (result.changed) {
        changed = true;
        paths.push({ field, from: move.from, to: move.to });
      }
    }
  }

  let after: MaintainerPolicy;
  try {
    after = parseMaintainerPolicy(projected);
  } catch {
    throw remapInvalid('Projected maintainer policy is invalid.');
  }
  for (const { from, to } of proof.moves) {
    for (const field of [
      'bootstrapEligiblePaths',
      'sealedImmutablePaths',
    ] as const) {
      if (
        pathSetMatches(before[field], from) !== pathSetMatches(after[field], to)
      ) {
        throw remapInvalid(
          `Maintainer policy ${field} changes authority semantics for ${from} -> ${to}.`,
        );
      }
    }
  }
  return Object.freeze({
    proof,
    paths: Object.freeze(paths.map((entry) => Object.freeze(entry))),
    mutation: changed
      ? Object.freeze({
          path: MAINTAINER_POLICY_PATH,
          expectedBeforeSha256: sha256Hex(beforeContent),
          content: `${JSON.stringify(projected, null, 2)}\n`,
        })
      : null,
  });
}

/**
 * Project every reviewed capability-profile path set, then re-run the landed
 * parser and effective role classifier. A destination that would gain, lose,
 * or change authority role is rejected rather than repaired by precedence
 * guesses.
 */
export function projectAuthorityRemapProfiles(request: {
  repositoryRoot: string;
  baseCommit: string;
  moveCommit: string;
  renamePairs: readonly AuthorityRemapPair[];
}): AuthorityRemapProfileProjection {
  const proof = verifyMechanicalMovePhase(request);
  const { beforeContent } = readUnchangedAuthorityText(
    request.repositoryRoot,
    proof,
    MAINTAINER_PROFILES_PATH,
  );
  const document = parseMaintainerProfilesDocument(beforeContent);
  const projectedProfiles: Record<string, unknown> = {};
  const profiles: Array<{
    profileId: string;
    from: string;
    to: string;
    beforeRole: FileRole;
    afterRole: FileRole;
    changedFields: readonly ProfilePathField[];
  }> = [];
  let changed = false;

  for (const [profileId, entry] of [...document.entries.entries()].sort(
    ([left], [right]) => comparePaths(left, right),
  )) {
    const projected = structuredClone(entry.raw) as Record<string, unknown>;
    const changedByMove = new Map<string, Set<ProfilePathField>>();
    for (const field of PROFILE_PATH_FIELDS) {
      let paths = [...entry.profile[field]];
      for (const move of proof.moves) {
        const result = projectPathSet(paths, move.from, move.to);
        paths = result.paths;
        if (result.changed) {
          changed = true;
          const key = `${move.from}\0${move.to}`;
          const fields = changedByMove.get(key) ?? new Set<ProfilePathField>();
          fields.add(field);
          changedByMove.set(key, fields);
        }
      }
      projected[field] = paths;
    }

    let after: CapabilityProfile;
    try {
      after = parseCapabilityProfile(projected);
    } catch {
      throw remapInvalid(
        `Projected capability profile ${profileId} is invalid.`,
      );
    }
    for (const move of proof.moves) {
      const beforeRole = classifyFileRole(entry.profile, move.from);
      const afterRole = classifyFileRole(after, move.to);
      if (beforeRole !== afterRole) {
        throw remapInvalid(
          `Capability profile ${profileId} changes role for ${move.from} -> ${move.to}.`,
        );
      }
      if (beforeRole !== undefined && afterRole !== undefined) {
        const key = `${move.from}\0${move.to}`;
        profiles.push({
          profileId,
          from: move.from,
          to: move.to,
          beforeRole,
          afterRole,
          changedFields: Object.freeze(
            [...(changedByMove.get(key) ?? [])].sort(comparePaths),
          ),
        });
      }
    }
    projectedProfiles[profileId] = projected;
  }

  profiles.sort(
    (left, right) =>
      comparePaths(left.profileId, right.profileId) ||
      comparePaths(left.from, right.from) ||
      comparePaths(left.to, right.to),
  );
  const projectedDocument = {
    ...document.raw,
    profiles: projectedProfiles,
  };
  return Object.freeze({
    proof,
    profiles: Object.freeze(
      profiles.map((entry) =>
        Object.freeze({ ...entry, changedFields: entry.changedFields }),
      ),
    ),
    mutation: changed
      ? Object.freeze({
          path: MAINTAINER_PROFILES_PATH,
          expectedBeforeSha256: sha256Hex(beforeContent),
          content: `${JSON.stringify(projectedDocument, null, 2)}\n`,
        })
      : null,
  });
}

/**
 * Compose one exact move proof and its live path-authority projections. This is
 * a pure reader/projector: it neither writes the worktree nor creates authority.
 * When no authority artifact changes, no empty authority-plan intent is minted.
 */
export function projectAuthorityRemap(request: {
  repositoryRoot: string;
  baseCommit: string;
  moveCommit: string;
  materializationCommit?: string;
  renamePairs: readonly AuthorityRemapPair[];
  authorityPlan: Readonly<{
    changeId: string;
    taskId: string;
    profileId: string;
    reason: string;
    message: string;
  }>;
}): AuthorityRemapProjection {
  validateAuthorityPlanMetadata(request.authorityPlan);
  const pathRoles = projectAuthorityRemapPathRoles(request);
  const materialization = resolveMaterializationBoundary(
    request.repositoryRoot,
    pathRoles.proof,
    request.materializationCommit,
  );
  assertNoEngineProjectionEndpointMove(pathRoles.proof);
  const checks = projectAuthorityRemapChecks(request);
  const guards = projectAuthorityRemapGuards(request);
  const maintainerPolicy = projectAuthorityRemapMaintainerPolicy(request);
  const profiles = projectAuthorityRemapProfiles(request);
  const mutations: AuthorityRemapMutation[] = [
    ...(pathRoles.mutation === null ? [] : [pathRoles.mutation]),
    ...(checks.mutation === null ? [] : [checks.mutation]),
    ...guards.mutations,
    ...(maintainerPolicy.mutation === null ? [] : [maintainerPolicy.mutation]),
    ...(profiles.mutation === null ? [] : [profiles.mutation]),
  ].sort((left, right) => comparePaths(left.path, right.path));
  if (
    mutations.length > 64 ||
    new Set(mutations.map(({ path }) => path)).size !== mutations.length
  ) {
    throw remapInvalid(
      'Authority remap projections exceed the existing authority-plan mutation contract.',
    );
  }
  if (mutations.length > 0) {
    assertAuthorityPlanProfileAllowsMutations(
      request.repositoryRoot,
      pathRoles.proof,
      request.authorityPlan.profileId,
      mutations,
    );
  }
  const regeneration = createRegenerationDescriptor(
    request.repositoryRoot,
    pathRoles.proof,
    materialization,
  );
  const candidateIntent: AuthorityRemapPlanIntent | null =
    mutations.length === 0
      ? null
      : Object.freeze({
          schemaVersion: 1 as const,
          kind: 'authority-plan-intent.v1' as const,
          ...request.authorityPlan,
          mutations: Object.freeze(
            mutations.map((mutation) => Object.freeze({ ...mutation })),
          ),
          externalEffects: Object.freeze([]) as readonly [],
          evidenceWaivers: Object.freeze([]) as readonly [],
        });
  const intent = regeneration === null ? candidateIntent : null;
  const authorityPlanIntentDigest =
    intent === null ? null : sha256(canonicalJson(intent));
  const roleBySource = new Map(
    pathRoles.roles.map((role) => [role.from, role] as const),
  );
  const moves = pathRoles.proof.moves.map((move) => {
    const role = roleBySource.get(move.from);
    if (role === undefined) {
      throw remapInvalid(
        `No role projection exists for moved path ${move.from}.`,
      );
    }
    return Object.freeze({
      ...move,
      role: Object.freeze({
        name: role.role,
        beforePattern: role.beforePattern,
        afterPattern: role.afterPattern,
      }),
    });
  });
  const projections = mutations.map((mutation) => {
    if (mutation.expectedBeforeSha256 === null || mutation.content === null) {
      throw remapInvalid(
        'Authority remap emitted an incomplete file mutation.',
      );
    }
    return Object.freeze({
      path: mutation.path,
      beforeSha256: `sha256:${mutation.expectedBeforeSha256}` as const,
      afterSha256: sha256(mutation.content),
    });
  });
  const identity = {
    schemaVersion: 1 as const,
    kind: 'workflow.authority-remap-manifest.v1' as const,
    baseCommit: pathRoles.proof.baseCommit,
    baseTree: pathRoles.proof.baseTree,
    moveCommit: pathRoles.proof.moveCommit,
    moveTree: pathRoles.proof.moveTree,
    materializationCommit: materialization.commit,
    materializationTree: materialization.tree,
    mechanicalProofDigest: pathRoles.proof.proofDigest,
    moves,
    projections,
    regenerationDescriptorDigest: regeneration?.descriptorDigest ?? null,
    authorityPlanIntentDigest,
  };
  const manifest = Object.freeze({
    ...identity,
    moves: Object.freeze(moves),
    projections: Object.freeze(projections),
    manifestDigest: sha256(canonicalJson(identity)),
  });
  return regeneration === null
    ? Object.freeze({
        status: 'ready' as const,
        manifest,
        intent,
        regeneration: null,
      })
    : Object.freeze({
        status: 'requires-regeneration' as const,
        manifest,
        intent: null,
        regeneration,
      });
}

function createRegenerationDescriptor(
  repositoryRoot: string,
  proof: MechanicalMoveProof,
  materialization: Readonly<{ commit: string; tree: string }>,
): AuthorityRemapRegenerationDescriptor | null {
  const protectedPatterns = readProtectedClosurePatterns(repositoryRoot, proof);
  const workspaceSourceRoots = readWorkspaceSourceRoots(repositoryRoot, proof);
  const steps = new Set<AuthorityRemapRegenerationStep>();
  const affectedMoves = proof.moves
    .filter(({ from, to }) => {
      const engineSource =
        isWithinEngineSource(from, workspaceSourceRoots) ||
        isWithinEngineSource(to, workspaceSourceRoots);
      const recoveryRuntime =
        isWithinRecoveryRuntime(from) || isWithinRecoveryRuntime(to);
      const protectedClosure = protectedPatterns.some(
        (pattern) =>
          matchesAllowedPath(from, pattern) || matchesAllowedPath(to, pattern),
      );
      if (engineSource) {
        for (const step of REGENERATION_STEPS) steps.add(step);
      } else if (recoveryRuntime) {
        steps.add('harness-bootstrap-runtime');
        steps.add('protected-capabilities');
      } else if (protectedClosure) {
        steps.add('protected-capabilities');
      }
      return engineSource || recoveryRuntime || protectedClosure;
    })
    .map(({ from, to }) => Object.freeze({ from, to }));
  if (affectedMoves.length === 0) return null;
  const orderedSteps = REGENERATION_STEPS.filter((step) => steps.has(step));
  const identity = {
    schemaVersion: 1 as const,
    kind: 'workflow.authority-remap-regeneration.v1' as const,
    mechanicalProofDigest: proof.proofDigest,
    moveTree: proof.moveTree,
    materializationCommit: materialization.commit,
    materializationTree: materialization.tree,
    affectedMoves,
    steps: orderedSteps,
  };
  return Object.freeze({
    ...identity,
    affectedMoves: Object.freeze(affectedMoves),
    steps: Object.freeze(orderedSteps),
    descriptorDigest: sha256(canonicalJson(identity)),
  });
}

function resolveMaterializationBoundary(
  repositoryRoot: string,
  proof: MechanicalMoveProof,
  requestedCommit: string | undefined,
): Readonly<{ commit: string; tree: string }> {
  const commit = requestedCommit ?? proof.moveCommit;
  if (!OBJECT_ID.test(commit)) {
    throw remapInvalid(
      'Authority remap materialization commit must be one exact full object ID.',
    );
  }
  if (commit === proof.moveCommit) {
    return Object.freeze({ commit, tree: proof.moveTree });
  }
  assertDirectReviewedContentChild(repositoryRoot, proof.moveCommit, commit);
  const tree = resolveCommitTree(repositoryRoot, commit);
  assertReviewedContentDiff(
    repositoryRoot,
    proof.moveCommit,
    proof.moveTree,
    commit,
    tree,
  );
  return Object.freeze({ commit, tree });
}

function assertDirectReviewedContentChild(
  repositoryRoot: string,
  moveCommit: string,
  contentCommit: string,
): void {
  assertRawCommitParent(
    repositoryRoot,
    contentCommit,
    moveCommit,
    'Authority remap materialization commit must be the single direct reviewed-content child of the mechanical move.',
  );
}

function assertReviewedContentDiff(
  repositoryRoot: string,
  moveCommit: string,
  moveTree: string,
  contentCommit: string,
  contentTree: string,
): void {
  let output: Buffer;
  try {
    output = runGitBuffer(repositoryRoot, [
      'diff',
      '--name-status',
      '--no-renames',
      '--diff-filter=ACDMRTUXB',
      '-z',
      moveCommit,
      contentCommit,
      '--',
    ]);
  } catch (error) {
    throw translateGitInputError(error);
  }
  const tokens = splitNul(output);
  if (tokens.length === 0 || tokens.length % 2 !== 0) {
    throw remapInvalid(
      'Authority remap reviewed-content commit must contain a non-empty exact diff.',
    );
  }
  const paths: string[] = [];
  for (let index = 0; index < tokens.length; index += 2) {
    const status = decodeUtf8(tokens[index]!);
    const changedPath = decodeUtf8(tokens[index + 1]!);
    if (status !== 'M') {
      throw remapInvalid(
        `Authority remap reviewed-content commit contains non-edit status ${status}.`,
      );
    }
    let normalized: string;
    try {
      normalized = normalizeExactRepositoryPath(changedPath);
    } catch {
      throw remapInvalid(
        'Authority remap reviewed-content commit contains an unsafe path.',
      );
    }
    if (
      normalized !== changedPath ||
      isAuthorityOwnedMaterializationPath(changedPath)
    ) {
      throw remapInvalid(
        `Authority remap reviewed-content commit changes authority-owned path ${changedPath}.`,
      );
    }
    paths.push(changedPath);
  }
  if (new Set(paths).size !== paths.length) {
    throw remapInvalid(
      'Authority remap reviewed-content commit contains duplicate paths.',
    );
  }

  const beforeEntries = entriesByUtf8Path(
    readPinnedTrackedTree({ repositoryRoot, treeOid: moveTree }).entries,
  );
  const afterEntries = entriesByUtf8Path(
    readPinnedTrackedTree({ repositoryRoot, treeOid: contentTree }).entries,
  );
  for (const changedPath of paths) {
    const before = beforeEntries.get(changedPath);
    const after = afterEntries.get(changedPath);
    if (
      before === undefined ||
      after === undefined ||
      before.objectType !== 'blob' ||
      after.objectType !== 'blob' ||
      !isRegularMode(before.mode) ||
      before.mode !== after.mode ||
      before.objectId === after.objectId
    ) {
      throw remapInvalid(
        `Authority remap reviewed-content path ${changedPath} is not one mode-preserving blob edit.`,
      );
    }
  }
}

function isAuthorityOwnedMaterializationPath(filePath: string): boolean {
  return (
    filePath === PATH_ROLES_PATH ||
    filePath === CHECKS_PATH ||
    filePath === CONFIG_PATH ||
    filePath === MAINTAINER_POLICY_PATH ||
    filePath === MAINTAINER_PROFILES_PATH ||
    filePath === PROTECTED_CAPABILITIES_PATH ||
    filePath === ENGINE_PROJECTION_REGISTRY_PATH ||
    filePath === BOOTSTRAP_ROOT ||
    filePath.startsWith(`${BOOTSTRAP_ROOT}/`) ||
    /^openspec\/changes\/[^/]+\/guard\.json$/u.test(filePath) ||
    filePath.startsWith('openspec/changes/archive/')
  );
}

function readProtectedClosurePatterns(
  repositoryRoot: string,
  proof: MechanicalMoveProof,
): string[] {
  const snapshot = readPinnedTrackedTree({
    repositoryRoot,
    treeOid: proof.baseTree,
  });
  const entry = entriesByUtf8Path(snapshot.entries).get(
    PROTECTED_CAPABILITIES_PATH,
  );
  if (entry === undefined) return [];
  if (entry.content === undefined) {
    throw remapInvalid(`${PROTECTED_CAPABILITIES_PATH} is not readable text.`);
  }
  let source: unknown;
  try {
    source = JSON.parse(entry.content.toString('utf8'));
  } catch {
    throw remapInvalid(`${PROTECTED_CAPABILITIES_PATH} is not valid JSON.`);
  }
  try {
    const manifest = parseProtectedCapabilitiesManifestSource(source);
    return [
      ...new Set(
        manifest.entries.flatMap(({ entrypoints, dependencies }) => [
          ...entrypoints,
          ...dependencies,
        ]),
      ),
    ].sort(comparePaths);
  } catch {
    throw remapInvalid(
      `${PROTECTED_CAPABILITIES_PATH} is not a valid manifest.`,
    );
  }
}

function readWorkspaceSourceRoots(
  repositoryRoot: string,
  proof: MechanicalMoveProof,
): string[] {
  const snapshot = readPinnedTrackedTree({
    repositoryRoot,
    treeOid: proof.baseTree,
  });
  const entry = entriesByUtf8Path(snapshot.entries).get(BUILT_IN_CLOSURE_PATH);
  if (entry === undefined) return ['packages/workflow-engine'];
  if (entry.content === undefined) {
    throw remapInvalid(`${BUILT_IN_CLOSURE_PATH} is not readable text.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(entry.content.toString('utf8'));
  } catch {
    throw remapInvalid(`${BUILT_IN_CLOSURE_PATH} is not valid JSON.`);
  }
  if (
    !isRecord(value) ||
    (value.kind !== 'built-in-engine-closure-manifest.v1' &&
      value.kind !== 'built-in-engine-closure-manifest.v2')
  ) {
    throw remapInvalid(`${BUILT_IN_CLOSURE_PATH} has an unsupported version.`);
  }
  if (value.kind === 'built-in-engine-closure-manifest.v1') {
    return ['packages/workflow-engine'];
  }
  if (
    value.scope !== 'workspace-runtime-source-closure' ||
    !Array.isArray(value.packages) ||
    value.packages.length === 0
  ) {
    throw remapInvalid(`${BUILT_IN_CLOSURE_PATH} has invalid workspace roots.`);
  }
  const roots = value.packages.map((descriptor) => {
    if (
      !isRecord(descriptor) ||
      Object.keys(descriptor).sort().join(',') !==
        'closureRoot,name,sourceRoot' ||
      typeof descriptor.name !== 'string' ||
      typeof descriptor.sourceRoot !== 'string' ||
      typeof descriptor.closureRoot !== 'string'
    ) {
      throw remapInvalid(
        `${BUILT_IN_CLOSURE_PATH} has an invalid workspace descriptor.`,
      );
    }
    let normalized: string;
    try {
      normalized = normalizeExactRepositoryPath(descriptor.sourceRoot);
    } catch {
      throw remapInvalid(
        `${BUILT_IN_CLOSURE_PATH} has an unsafe workspace source root.`,
      );
    }
    if (normalized !== descriptor.sourceRoot) {
      throw remapInvalid(
        `${BUILT_IN_CLOSURE_PATH} has a non-canonical workspace source root.`,
      );
    }
    return normalized;
  });
  if (
    roots[0] !== 'packages/workflow-engine' ||
    new Set(roots).size !== roots.length
  ) {
    throw remapInvalid(
      `${BUILT_IN_CLOSURE_PATH} has ambiguous workspace roots.`,
    );
  }
  return roots;
}

function isWithinEngineSource(
  filePath: string,
  workspaceSourceRoots: readonly string[],
): boolean {
  return workspaceSourceRoots.some(
    (sourceRoot) =>
      filePath === `${sourceRoot}/package.json` ||
      filePath.startsWith(`${sourceRoot}/src/`),
  );
}

function isWithinRecoveryRuntime(filePath: string): boolean {
  const root = 'packages/workflow-engine/bootstrap/recovery-runtime';
  return filePath === root || filePath.startsWith(`${root}/`);
}

function readUnchangedAuthorityText(
  repositoryRoot: string,
  proof: MechanicalMoveProof,
  authorityPath: string,
): { beforeContent: string } {
  const baseSnapshot = readPinnedTrackedTree({
    repositoryRoot,
    treeOid: proof.baseTree,
  });
  const moveSnapshot = readPinnedTrackedTree({
    repositoryRoot,
    treeOid: proof.moveTree,
  });
  const before = requireTrackedTextEntry(baseSnapshot.entries, authorityPath);
  const after = requireTrackedTextEntry(moveSnapshot.entries, authorityPath);
  if (before.objectId !== after.objectId || before.mode !== after.mode) {
    throw remapInvalid(
      `The move commit must not edit or move ${authorityPath}.`,
    );
  }
  return { beforeContent: before.content!.toString('utf8') };
}

function projectPathSet(
  candidate: readonly string[],
  from: string,
  to: string,
): { paths: string[]; changed: boolean } {
  if (!pathSetMatches(candidate, from)) {
    return { paths: [...candidate], changed: false };
  }
  const withoutExactSource = candidate.filter((pattern) => pattern !== from);
  let changed = withoutExactSource.length !== candidate.length;
  if (!pathSetMatches(withoutExactSource, to)) {
    withoutExactSource.push(to);
    changed = true;
  }
  return {
    paths: [...new Set(withoutExactSource)].sort(),
    changed,
  };
}

function pathSetMatches(
  patterns: readonly string[],
  filePath: string,
): boolean {
  return patterns.some((pattern) => matchesAllowedPath(filePath, pattern));
}

function parseMaintainerProfilesDocument(content: string): {
  raw: Record<string, unknown>;
  entries: Map<
    string,
    { raw: Record<string, unknown>; profile: CapabilityProfile }
  >;
} {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw remapInvalid(`${MAINTAINER_PROFILES_PATH} is not valid JSON.`);
  }
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(',') !== 'profiles,schemaVersion' ||
    value.schemaVersion !== 1 ||
    !isRecord(value.profiles)
  ) {
    throw remapInvalid(`${MAINTAINER_PROFILES_PATH} is malformed.`);
  }
  const entries = new Map<
    string,
    { raw: Record<string, unknown>; profile: CapabilityProfile }
  >();
  for (const [profileId, raw] of Object.entries(value.profiles).sort(
    ([left], [right]) => comparePaths(left, right),
  )) {
    if (!isRecord(raw)) {
      throw remapInvalid(`Capability profile ${profileId} is malformed.`);
    }
    let profile: CapabilityProfile;
    try {
      profile = parseCapabilityProfile(raw);
    } catch {
      throw remapInvalid(`Capability profile ${profileId} is invalid.`);
    }
    if (profile.id !== profileId) {
      throw remapInvalid(
        `Capability profile ${profileId} has a mismatched ID.`,
      );
    }
    entries.set(profileId, { raw, profile });
  }
  return { raw: value, entries };
}

function assertNoEngineProjectionEndpointMove(
  proof: MechanicalMoveProof,
): void {
  const enginePaths = new Set([
    ...engineProjectionDefinitions().map(({ path }) => path),
    PROTECTED_CAPABILITIES_PATH,
    PROTECTED_CAPABILITIES_LOADER_PATH,
  ]);
  for (const { from, to } of proof.moves) {
    const endpoint = enginePaths.has(from)
      ? from
      : enginePaths.has(to)
        ? to
        : null;
    if (endpoint !== null) {
      throw remapInvalid(
        `Code-owned projection path ${endpoint} has no exact registry-and-renderer remap.`,
      );
    }
  }
}

function assertAuthorityPlanProfileAllowsMutations(
  repositoryRoot: string,
  proof: MechanicalMoveProof,
  profileId: string,
  mutations: readonly AuthorityRemapMutation[],
): void {
  const snapshot = readPinnedTrackedTree({
    repositoryRoot,
    treeOid: proof.baseTree,
  });
  const entry = requireTrackedTextEntry(
    snapshot.entries,
    MAINTAINER_PROFILES_PATH,
  );
  const document = parseMaintainerProfilesDocument(
    entry.content!.toString('utf8'),
  );
  const profile = document.entries.get(profileId)?.profile;
  if (profile === undefined) {
    throw remapInvalid(
      `Authority remap profile ${profileId} is absent from the pinned trust base.`,
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

function normalizeRenamePairs(
  candidate: readonly AuthorityRemapPair[],
): AuthorityRemapPair[] {
  if (
    !Array.isArray(candidate) ||
    candidate.length === 0 ||
    candidate.length > MAX_RENAME_PAIRS
  ) {
    throw remapInvalid(
      `Mechanical move proof requires 1-${MAX_RENAME_PAIRS} declared rename pairs.`,
    );
  }
  const pairs = candidate.map((pair) => {
    if (
      pair === null ||
      typeof pair !== 'object' ||
      Object.keys(pair).sort().join(',') !== 'from,to' ||
      typeof pair.from !== 'string' ||
      typeof pair.to !== 'string'
    ) {
      throw remapInvalid('A declared rename pair is malformed.');
    }
    let from: string;
    let to: string;
    try {
      from = normalizeExactRepositoryPath(pair.from);
      to = normalizeExactRepositoryPath(pair.to);
    } catch {
      throw remapInvalid('A declared rename pair contains an unsafe path.');
    }
    if (from === to) {
      throw remapInvalid('A declared rename pair must not be a no-op.');
    }
    return { from, to };
  });
  pairs.sort((left, right) => comparePaths(left.from, right.from));

  const from = new Set<string>();
  const to = new Set<string>();
  const caseFolded = new Set<string>();
  for (const pair of pairs) {
    if (from.has(pair.from) || to.has(pair.to)) {
      throw remapInvalid('Declared rename pairs contain a duplicate endpoint.');
    }
    from.add(pair.from);
    to.add(pair.to);
    for (const endpoint of [pair.from, pair.to]) {
      const folded = endpoint.toLocaleLowerCase('en-US');
      if (caseFolded.has(folded)) {
        throw remapInvalid(
          'Declared rename pairs contain a case-alias or overlapping endpoint.',
        );
      }
      caseFolded.add(folded);
    }
  }
  if ([...from].some((source) => to.has(source))) {
    throw remapInvalid(
      'Declared rename pairs may not use an endpoint as both source and target.',
    );
  }
  return pairs;
}

function assertDirectChild(
  repositoryRoot: string,
  baseCommit: string,
  moveCommit: string,
): void {
  assertRawCommitParent(
    repositoryRoot,
    moveCommit,
    baseCommit,
    'Mechanical move proof requires the move commit to have exactly the base commit as its parent.',
  );
}

function assertRawCommitParent(
  repositoryRoot: string,
  commit: string,
  expectedParent: string,
  mismatchMessage: string,
): void {
  let rawCommit: Buffer;
  try {
    rawCommit = runGitBuffer(repositoryRoot, ['cat-file', 'commit', commit]);
  } catch (error) {
    throw translateGitInputError(error);
  }
  const headerEnd = rawCommit.indexOf('\n\n');
  const parents =
    headerEnd === -1
      ? []
      : rawCommit
          .subarray(0, headerEnd)
          .toString('latin1')
          .split('\n')
          .filter((line) => line.startsWith('parent '));
  if (parents.length !== 1 || parents[0] !== `parent ${expectedParent}`) {
    throw remapInvalid(mismatchMessage);
  }
}

function resolveCommitTree(repositoryRoot: string, commit: string): string {
  try {
    const type = runGitBuffer(repositoryRoot, ['cat-file', '-t', commit])
      .toString('ascii')
      .trim();
    if (type !== 'commit') {
      throw remapInvalid('A mechanical move endpoint is not a commit object.');
    }
    const tree = runGitBuffer(repositoryRoot, [
      'rev-parse',
      '--verify',
      `${commit}^{tree}`,
    ])
      .toString('ascii')
      .trim();
    if (!OBJECT_ID.test(tree)) {
      throw remapInvalid('A mechanical move commit has no exact tree object.');
    }
    return tree;
  } catch (error) {
    throw translateGitInputError(error);
  }
}

function entriesByUtf8Path(
  entries: readonly TrackedTreeEntry[],
): Map<string, TrackedTreeEntry> {
  const result = new Map<string, TrackedTreeEntry>();
  for (const entry of entries) {
    if (entry.path.utf8 !== null) {
      result.set(entry.path.utf8, entry);
    }
  }
  return result;
}

function requireTrackedTextEntry(
  entries: readonly TrackedTreeEntry[],
  expectedPath: string,
): TrackedTreeEntry {
  const matching = entries.filter(({ path }) => path.utf8 === expectedPath);
  const entry = matching[0];
  if (
    matching.length !== 1 ||
    entry === undefined ||
    entry.content === undefined ||
    !isRegularMode(entry.mode)
  ) {
    throw remapInvalid(
      `Pinned tree has no readable regular ${expectedPath} authority artifact.`,
    );
  }
  return entry;
}

function parseChangeRoot(content: string): string {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw remapInvalid(`${CONFIG_PATH} is not valid JSON.`);
  }
  if (!isRecord(value) || typeof value.changeRoot !== 'string') {
    throw remapInvalid(`${CONFIG_PATH} has no projectable change root.`);
  }
  try {
    return normalizeExactRepositoryPath(value.changeRoot);
  } catch {
    throw remapInvalid(`${CONFIG_PATH} has an unsafe change root.`);
  }
}

function validateAuthorityPlanMetadata(
  value: Readonly<{
    changeId: string;
    taskId: string;
    profileId: string;
    reason: string;
    message: string;
  }>,
): void {
  try {
    assertChangeId(value.changeId);
    assertTaskId(value.taskId);
  } catch {
    throw remapInvalid(
      'Authority remap plan metadata has an invalid identifier.',
    );
  }
  if (
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.profileId) ||
    value.reason.trim() !== value.reason ||
    value.reason.length < 12 ||
    value.reason.length > 500 ||
    value.message.trim() !== value.message ||
    value.message.length < 1 ||
    value.message.includes('\n')
  ) {
    throw remapInvalid('Authority remap plan metadata is malformed.');
  }
}

function activeGuardEntries(
  entries: readonly TrackedTreeEntry[],
  changeRoot: string,
): Map<string, TrackedTreeEntry> {
  const prefix = `${changeRoot}/`;
  const result = new Map<string, TrackedTreeEntry>();
  for (const entry of entries) {
    const entryPath = entry.path.utf8;
    if (
      entryPath === null ||
      !entryPath.startsWith(prefix) ||
      !entryPath.endsWith('/guard.json')
    ) {
      continue;
    }
    const relative = entryPath.slice(prefix.length);
    const segments = relative.split('/');
    if (
      segments[0] === 'archive' ||
      segments.some((segment) => segment.startsWith('.'))
    ) {
      continue;
    }
    if (segments.length !== 2 || segments[1] !== 'guard.json') {
      throw remapInvalid(`Unexpected active guard path ${entryPath}.`);
    }
    try {
      assertChangeId(segments[0]!);
    } catch {
      throw remapInvalid(
        `Active guard path ${entryPath} has an invalid change ID.`,
      );
    }
    if (entry.content === undefined || !isRegularMode(entry.mode)) {
      throw remapInvalid(
        `Active guard ${entryPath} is not readable regular text.`,
      );
    }
    result.set(entryPath, entry);
  }
  return new Map(
    [...result].sort(([left], [right]) => comparePaths(left, right)),
  );
}

function parseGuardSource(
  content: string,
  guardPath: string,
  changeRoot: string,
): {
  raw: Record<string, unknown>;
  tasks: Record<
    string,
    {
      raw: Record<string, unknown>;
      allowedPaths: string[];
    }
  >;
} {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw remapInvalid(`Active guard ${guardPath} is not valid JSON.`);
  }
  const changeId = guardPath.slice(
    `${changeRoot}/`.length,
    -'/guard.json'.length,
  );
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(',') !== 'changeId,schemaVersion,tasks' ||
    value.schemaVersion !== 1 ||
    value.changeId !== changeId ||
    !isRecord(value.tasks) ||
    Object.keys(value.tasks).length === 0
  ) {
    throw remapInvalid(`Active guard ${guardPath} is malformed.`);
  }
  const tasks: Record<
    string,
    { raw: Record<string, unknown>; allowedPaths: string[] }
  > = {};
  for (const [taskId, policy] of Object.entries(value.tasks)) {
    if (
      !isRecord(policy) ||
      Object.keys(policy).sort().join(',') !== 'allowedPaths,requiredChecks' ||
      !Array.isArray(policy.allowedPaths) ||
      policy.allowedPaths.length === 0 ||
      !policy.allowedPaths.every(
        (allowedPath) => typeof allowedPath === 'string',
      ) ||
      !Array.isArray(policy.requiredChecks) ||
      policy.requiredChecks.length === 0 ||
      !policy.requiredChecks.every((checkId) => typeof checkId === 'string')
    ) {
      throw remapInvalid(
        `Active guard ${guardPath} task ${taskId} is malformed.`,
      );
    }
    for (const allowedPath of policy.allowedPaths) {
      try {
        normalizePolicyPath(allowedPath);
      } catch {
        throw remapInvalid(
          `Active guard ${guardPath} task ${taskId} has an unsafe allowed path.`,
        );
      }
    }
    tasks[taskId] = {
      raw: policy,
      allowedPaths: [...policy.allowedPaths],
    };
  }
  return { raw: value, tasks };
}

function exactPatternRole(
  roles: Readonly<Record<string, readonly string[]>>,
  expectedPath: string,
): PathRole | null {
  for (const [role, patterns] of Object.entries(roles)) {
    if (patterns.includes(expectedPath)) return role as PathRole;
  }
  return null;
}

function containsEmbeddedPathReference(
  value: string,
  movedPath: string,
): boolean {
  let offset = value.indexOf(movedPath);
  while (offset !== -1) {
    const before = value.slice(0, offset);
    const after = value.slice(offset + movedPath.length);
    const leftBoundary =
      offset === 0 || before.endsWith('./') || /[\s=,:;([{]$/.test(before);
    const rightBoundary =
      after.length === 0 ||
      after.startsWith('/') ||
      /^[\s=,:;)\]}]/.test(after);
    if (leftBoundary && rightBoundary) return true;
    offset = value.indexOf(movedPath, offset + 1);
  }
  return false;
}

function assertNoCaseAlias(
  entries: ReadonlyMap<string, TrackedTreeEntry>,
  exactPath: string,
): void {
  const folded = exactPath.toLocaleLowerCase('en-US');
  const alias = [...entries.keys()].find(
    (candidate) =>
      candidate !== exactPath &&
      candidate.toLocaleLowerCase('en-US') === folded,
  );
  if (alias !== undefined) {
    throw remapInvalid(
      `Mechanical move endpoint ${exactPath} aliases pinned tree path ${alias} by case.`,
    );
  }
}

function assertPureDeclaredDiff(
  repositoryRoot: string,
  baseCommit: string,
  moveCommit: string,
  pairs: readonly AuthorityRemapPair[],
): void {
  let output: Buffer;
  try {
    output = runGitBuffer(repositoryRoot, [
      'diff',
      '--name-status',
      '--no-renames',
      '--diff-filter=ACDMRTUXB',
      '-z',
      baseCommit,
      moveCommit,
      '--',
    ]);
  } catch (error) {
    throw translateGitInputError(error);
  }
  const tokens = splitNul(output);
  if (tokens.length % 2 !== 0) {
    throw remapInvalid('Mechanical move diff has a malformed status record.');
  }
  const added: string[] = [];
  const deleted: string[] = [];
  for (let index = 0; index < tokens.length; index += 2) {
    const status = decodeUtf8(tokens[index]!);
    const changedPath = decodeUtf8(tokens[index + 1]!);
    if (status === 'A') {
      added.push(changedPath);
    } else if (status === 'D') {
      deleted.push(changedPath);
    } else {
      throw remapInvalid(
        `Mechanical move commit contains non-move status ${status}.`,
      );
    }
  }
  added.sort(comparePaths);
  deleted.sort(comparePaths);
  const expectedAdded = pairs.map(({ to }) => to).sort(comparePaths);
  const expectedDeleted = pairs.map(({ from }) => from).sort(comparePaths);
  if (
    !sameStrings(added, expectedAdded) ||
    !sameStrings(deleted, expectedDeleted)
  ) {
    throw remapInvalid(
      'Mechanical move diff does not exactly match the declared rename endpoints.',
    );
  }
}

function splitNul(output: Buffer): Buffer[] {
  if (output.length === 0 || output[output.length - 1] !== NUL) {
    throw remapInvalid('Mechanical move diff is not a non-empty NUL stream.');
  }
  const tokens: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== NUL) continue;
    if (index === start) {
      throw remapInvalid('Mechanical move diff contains an empty token.');
    }
    tokens.push(output.subarray(start, index));
    start = index + 1;
  }
  return tokens;
}

function decodeUtf8(value: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    throw remapInvalid('Mechanical move diff contains a non-UTF-8 path.');
  }
}

function isRegularMode(value: string): value is '100644' | '100755' {
  return value === '100644' || value === '100755';
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

function sha256(value: string): `sha256:${string}` {
  return `sha256:${sha256Hex(value)}`;
}

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function translateGitInputError(error: unknown): WorkflowError {
  if (error instanceof WorkflowError) {
    if (error.code === 'AUTHORITY_REMAP_INVALID') return error;
    if (error.code !== 'GIT_COMMAND_FAILED') return error;
  }
  return remapInvalid('A mechanical move commit or tree cannot be resolved.');
}

function remapInvalid(message: string): WorkflowError {
  return workflowError(
    'AUTHORITY_REMAP_INVALID',
    message,
    ExitCode.verification,
  );
}
