import crypto from 'node:crypto';
import path from 'node:path';

import { canonicalJson } from './canonical-json.ts';
import { ExitCode, workflowError } from './errors.ts';

const TARGET_SCHEMA = 'plan-target.v1';
const CHANGE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const WINDOWS_ABSOLUTE_PATTERN = /^[a-zA-Z]:\//;
const UNSUPPORTED_PATH_GLOB_PATTERN = /[*?[\]{}!]/;
const STRUCTURED_RUNTIME_ONLY_KEYS = new Set([
  'runtimeMetadata',
  'timestamp',
  'timestamps',
  'createdAt',
  'updatedAt',
  'observedAt',
  'startedAt',
  'finishedAt',
  'completedAt',
  'latency',
  'latencyMs',
  'elapsed',
  'elapsedMs',
  'durationMs',
  'retryCount',
  'pid',
  'processId',
  'uiOrder',
  'displayOrder',
  'displayMetadata',
  'invocationDisplayMetadata',
]);

/**
 * A GFM task checkbox marker at the head of a list item. Only the completion
 * byte is engine-owned; normalizing it keeps a checked task from staling the
 * planning target while preserving the task ID, text, order, and heading bytes.
 */
const TASK_CHECKBOX_PATTERN = /^(- \[)[ xX](\] \d+(?:\.\d+)+\s+.*\S.*)$/gm;

/**
 * The exact typed component closure of a review target. Each role binds one
 * fixed component kind; `one` roles must appear exactly once and `many` roles at
 * least once. The review artifact itself and any unknown role are excluded, so a
 * `plan-review` component fails closed rather than being folded into its own
 * subject.
 */
const COMPONENT_RULES = {
  'schema-metadata': { kind: 'structured-json', cardinality: 'one' },
  proposal: { kind: 'authored-markdown', cardinality: 'one' },
  design: { kind: 'mixed-markdown', cardinality: 'one' },
  'delta-spec': { kind: 'authored-markdown', cardinality: 'many' },
  tasks: { kind: 'tasks-markdown', cardinality: 'one' },
  guard: { kind: 'structured-json', cardinality: 'one' },
  execution: { kind: 'structured-json', cardinality: 'one' },
  investigation: { kind: 'structured-json', cardinality: 'one' },
  'requirement-clause': { kind: 'requirement-clause', cardinality: 'many' },
  policy: { kind: 'policy', cardinality: 'many' },
} as const;

type ComponentRole = keyof typeof COMPONENT_RULES;

export type PlanTargetSourceNode = {
  nodeId: string;
  resultDigest: string;
};

export type PlanTargetComponentInput =
  | {
      kind: 'structured-json';
      role: string;
      path: string;
      schemaDigest: string;
      value: unknown;
    }
  | {
      kind: 'authored-markdown';
      role: string;
      path: string;
      content: string;
    }
  | {
      kind: 'mixed-markdown';
      role: string;
      path: string;
      authoredRegions: string[];
      managedProjection: {
        renderer: string;
        rendererDigest: string;
        sourceNodes: PlanTargetSourceNode[];
      };
    }
  | {
      kind: 'tasks-markdown';
      role: string;
      path: string;
      content: string;
    }
  | {
      kind: 'requirement-clause';
      role: string;
      path: string;
      requirement: string;
      scenario: string;
      content: string;
    }
  | {
      kind: 'policy';
      role: string;
      path: string;
      name: string;
      version: number;
      digest: string;
    };

export type PlanTargetInput = {
  schemaVersion: 1;
  changeId: string;
  schemaName: string;
  components: PlanTargetComponentInput[];
};

/**
 * A conservative, digest-only view of one bound component. Raw authored bytes,
 * structured values, and any runtime metadata are collapsed into
 * `componentDigest` so the immutable target never re-exports mutable input.
 */
export type PlanTargetComponentView = {
  kind: string;
  role: string;
  path: string;
  identityDigest: string;
  componentDigest: string;
};

export type PlanTarget = {
  schemaVersion: 1;
  changeId: string;
  schemaName: string;
  targetDigest: string;
  components: PlanTargetComponentView[];
};

/**
 * Bind a component-typed planning set into an immutable review target. Each
 * enumerated component is canonicalized by its fixed rule: engine-owned
 * structured JSON by semantic key order, authored Markdown by LF-normalized
 * bytes, tasks with the completion checkbox normalized, mixed documents by
 * separate authored regions plus managed projection identity, and the target
 * digest binds the sorted component digests, schema identity, and change ID.
 * General prose, whitespace, or model-based equivalence never participates.
 */
export function createPlanTarget(input: PlanTargetInput): PlanTarget {
  if (
    !isPlainRecord(input) ||
    !hasExactKeys(input, [
      'schemaVersion',
      'changeId',
      'schemaName',
      'components',
    ])
  ) {
    throw targetInvalid('Plan target input shape is malformed.');
  }
  if (input.schemaVersion !== 1) {
    throw targetInvalid('Plan target schema version must be 1.');
  }
  if (
    typeof input.changeId !== 'string' ||
    !CHANGE_ID_PATTERN.test(input.changeId)
  ) {
    throw targetInvalid('Plan target change ID is malformed.');
  }
  if (
    typeof input.schemaName !== 'string' ||
    !CHANGE_ID_PATTERN.test(input.schemaName)
  ) {
    throw targetInvalid('Plan target schema name is malformed.');
  }
  if (!isDenseArray(input.components)) {
    throw targetInvalid('Plan target components must be an array.');
  }

  const views: PlanTargetComponentView[] = [];
  const seenIdentities = new Set<string>();
  const seenLocations = new Set<string>();
  const roleCounts = new Map<ComponentRole, number>();

  for (const component of input.components) {
    const view = canonicalizeComponent(component, input.changeId);
    if (seenIdentities.has(view.identityDigest)) {
      throw targetInvalid(
        'Plan target contains a duplicate component identity.',
      );
    }
    seenIdentities.add(view.identityDigest);

    const location = componentLocationKey(view);
    if (view.role !== 'requirement-clause' && seenLocations.has(location)) {
      throw targetInvalid(
        'Plan target contains a duplicate component location.',
      );
    }
    seenLocations.add(location);
    const role = view.role as ComponentRole;
    roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);
    views.push(view);
  }

  assertComponentCardinality(roleCounts);

  views.sort(compareComponentViews);

  const targetDigest = planTargetDigest({
    schemaVersion: input.schemaVersion,
    changeId: input.changeId,
    schemaName: input.schemaName,
    components: views,
  });

  return assertPlanTarget({
    schemaVersion: 1,
    changeId: input.changeId,
    schemaName: input.schemaName,
    targetDigest,
    components: views,
  });
}

/**
 * Validate and detach a serialized plan target. Replay callers must not trust a
 * stored digest: the complete canonical component view is validated, required
 * cardinality and ordering are re-established, and `targetDigest` is recomputed
 * before the frozen copy is returned.
 */
export function assertPlanTarget(value: unknown): PlanTarget {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'changeId',
      'schemaName',
      'targetDigest',
      'components',
    ])
  ) {
    throw targetInvalid('Serialized plan target shape is malformed.');
  }
  if (value.schemaVersion !== 1) {
    throw targetInvalid('Serialized plan target schema version must be 1.');
  }
  if (
    typeof value.changeId !== 'string' ||
    !CHANGE_ID_PATTERN.test(value.changeId)
  ) {
    throw targetInvalid('Serialized plan target change ID is malformed.');
  }
  if (
    typeof value.schemaName !== 'string' ||
    !CHANGE_ID_PATTERN.test(value.schemaName)
  ) {
    throw targetInvalid('Serialized plan target schema name is malformed.');
  }
  if (!isDigest(value.targetDigest) || !isDenseArray(value.components)) {
    throw targetInvalid('Serialized plan target identity is malformed.');
  }

  const views = value.components.map((component) =>
    assertComponentView(component, value.changeId as string),
  );
  const roleCounts = new Map<ComponentRole, number>();
  const seenIdentities = new Set<string>();
  const seenDigests = new Set<string>();
  const seenLocations = new Set<string>();

  for (const view of views) {
    const role = view.role as ComponentRole;
    roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);
    if (seenIdentities.has(view.identityDigest)) {
      throw targetInvalid(
        'Serialized plan target contains a duplicate component identity.',
      );
    }
    if (seenDigests.has(view.componentDigest)) {
      throw targetInvalid(
        'Serialized plan target contains a duplicate component digest.',
      );
    }
    seenIdentities.add(view.identityDigest);
    seenDigests.add(view.componentDigest);

    const location = componentLocationKey(view);
    if (view.role !== 'requirement-clause' && seenLocations.has(location)) {
      throw targetInvalid(
        'Serialized plan target contains a duplicate component location.',
      );
    }
    seenLocations.add(location);
  }
  assertComponentCardinality(roleCounts);
  assertCanonicalComponentOrder(views);

  const target: PlanTarget = {
    schemaVersion: 1,
    changeId: value.changeId,
    schemaName: value.schemaName,
    targetDigest: value.targetDigest,
    components: views,
  };
  if (planTargetDigest(target) !== target.targetDigest) {
    throw targetInvalid(
      'Serialized plan target digest does not match its content.',
    );
  }
  return deepFreeze(target);
}

function canonicalizeComponent(
  component: PlanTargetComponentInput,
  changeId: string,
): PlanTargetComponentView {
  if (!isPlainRecord(component)) {
    throw targetInvalid('Plan target component must be an object.');
  }
  const role = component.role;
  if (typeof role !== 'string' || !(role in COMPONENT_RULES)) {
    throw targetInvalid('Plan target component role is not enumerated.');
  }
  const rule = COMPONENT_RULES[role as ComponentRole];
  if (component.kind !== rule.kind) {
    throw targetInvalid(`Plan target ${role} component kind is unexpected.`);
  }
  const componentPath = assertComponentPath(
    role as ComponentRole,
    component.path,
    changeId,
  );

  const semantic = componentSemantic(component);
  const identityDigest = componentIdentityDigest(component, componentPath);
  return {
    kind: component.kind,
    role,
    path: componentPath,
    identityDigest,
    componentDigest: sha256(
      canonicalJson({
        schema: `plan-target.${component.kind}.v1`,
        kind: component.kind,
        role,
        path: componentPath,
        identityDigest,
        ...semantic,
      }),
    ),
  };
}

function componentSemantic(
  component: PlanTargetComponentInput,
): Record<string, unknown> {
  switch (component.kind) {
    case 'structured-json': {
      assertExactKeys(component, [
        'kind',
        'role',
        'path',
        'schemaDigest',
        'value',
      ]);
      if (!isDigest(component.schemaDigest)) {
        throw targetInvalid('Structured component schema digest is malformed.');
      }
      let value: string;
      try {
        value = canonicalJson(
          projectStructuredSemantics(
            JSON.parse(canonicalJson(component.value)) as unknown,
          ),
        );
      } catch {
        throw targetInvalid(
          'Structured component value is not canonical JSON.',
        );
      }
      return { schemaDigest: component.schemaDigest, value };
    }
    case 'authored-markdown': {
      assertExactKeys(component, ['kind', 'role', 'path', 'content']);
      return { content: normalizeLf(assertContent(component.content)) };
    }
    case 'tasks-markdown': {
      assertExactKeys(component, ['kind', 'role', 'path', 'content']);
      return {
        content: normalizeTaskCompletion(
          normalizeLf(assertContent(component.content)),
        ),
      };
    }
    case 'requirement-clause': {
      assertExactKeys(component, [
        'kind',
        'role',
        'path',
        'requirement',
        'scenario',
        'content',
      ]);
      if (
        !isHeadingIdentity(component.requirement) ||
        !isHeadingIdentity(component.scenario)
      ) {
        throw targetInvalid('Requirement clause identity is malformed.');
      }
      return {
        requirement: component.requirement,
        scenario: component.scenario,
        content: normalizeLf(assertContent(component.content)),
      };
    }
    case 'policy': {
      assertExactKeys(component, [
        'kind',
        'role',
        'path',
        'name',
        'version',
        'digest',
      ]);
      if (
        typeof component.name !== 'string' ||
        !CHANGE_ID_PATTERN.test(component.name) ||
        !Number.isInteger(component.version) ||
        component.version < 1 ||
        !isDigest(component.digest)
      ) {
        throw targetInvalid('Policy component identity is malformed.');
      }
      return {
        name: component.name,
        version: component.version,
        digest: component.digest,
      };
    }
    case 'mixed-markdown': {
      assertExactKeys(component, [
        'kind',
        'role',
        'path',
        'authoredRegions',
        'managedProjection',
      ]);
      if (
        !isDenseArray(component.authoredRegions) ||
        component.authoredRegions.length === 0 ||
        !component.authoredRegions.every((region) => typeof region === 'string')
      ) {
        throw targetInvalid('Mixed component authored regions are malformed.');
      }
      const projection = component.managedProjection;
      if (
        !isPlainRecord(projection) ||
        !hasExactKeys(projection, ['renderer', 'rendererDigest', 'sourceNodes'])
      ) {
        throw targetInvalid('Mixed component managed projection is malformed.');
      }
      if (
        typeof projection.renderer !== 'string' ||
        projection.renderer.trim().length === 0 ||
        !isDigest(projection.rendererDigest) ||
        !isDenseArray(projection.sourceNodes) ||
        projection.sourceNodes.length === 0
      ) {
        throw targetInvalid('Mixed component managed projection is malformed.');
      }
      const seenSourceNodes = new Set<string>();
      const sourceNodes = projection.sourceNodes.map((node) => {
        if (
          !isPlainRecord(node) ||
          !hasExactKeys(node, ['nodeId', 'resultDigest'])
        ) {
          throw targetInvalid('Mixed component source node is malformed.');
        }
        if (!isDigest(node.nodeId) || !isDigest(node.resultDigest)) {
          throw targetInvalid(
            'Mixed component source node digest is malformed.',
          );
        }
        if (seenSourceNodes.has(node.nodeId)) {
          throw targetInvalid(
            'Mixed component contains a duplicate source node identity.',
          );
        }
        seenSourceNodes.add(node.nodeId);
        return { nodeId: node.nodeId, resultDigest: node.resultDigest };
      });
      sourceNodes.sort(compareSourceNodes);
      return {
        authoredRegions: component.authoredRegions.map(normalizeLf),
        managedProjection: {
          renderer: projection.renderer,
          rendererDigest: projection.rendererDigest,
          sourceNodes,
        },
      };
    }
    default: {
      throw targetInvalid('Plan target component kind is not enumerated.');
    }
  }
}

function componentIdentityDigest(
  component: PlanTargetComponentInput,
  componentPath: string,
): string {
  const identity: Record<string, unknown> = {
    schema: 'plan-target-component-identity.v1',
    kind: component.kind,
    role: component.role,
    path: componentPath,
  };
  if (component.kind === 'requirement-clause') {
    identity.requirement = component.requirement;
    identity.scenario = component.scenario;
  } else if (component.kind === 'policy') {
    identity.name = component.name;
    identity.version = component.version;
  }
  return sha256(canonicalJson(identity));
}

/**
 * Structured planning artifacts carry a small, code-owned set of observation
 * fields that are deliberately outside planning semantics. Remove only those
 * enumerated fields at every object depth; caller-provided configuration cannot
 * widen this list, and all other keys remain digest-bearing.
 */
function projectStructuredSemantics(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(projectStructuredSemantics);
  }
  if (!isPlainRecord(value)) {
    return value;
  }
  const projected: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of Object.keys(value)) {
    if (!STRUCTURED_RUNTIME_ONLY_KEYS.has(key)) {
      projected[key] = projectStructuredSemantics(value[key]);
    }
  }
  return projected;
}

function assertComponentView(
  value: unknown,
  changeId: string,
): PlanTargetComponentView {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      'kind',
      'role',
      'path',
      'identityDigest',
      'componentDigest',
    ])
  ) {
    throw targetInvalid('Serialized plan target component is malformed.');
  }
  const role = value.role;
  if (typeof role !== 'string' || !(role in COMPONENT_RULES)) {
    throw targetInvalid(
      'Serialized plan target component role is not enumerated.',
    );
  }
  const rule = COMPONENT_RULES[role as ComponentRole];
  const kind = value.kind;
  if (typeof kind !== 'string' || kind !== rule.kind) {
    throw targetInvalid(
      `Serialized plan target ${role} component kind is unexpected.`,
    );
  }
  const componentPath = assertComponentPath(
    role as ComponentRole,
    value.path,
    changeId,
  );
  if (!isDigest(value.identityDigest) || !isDigest(value.componentDigest)) {
    throw targetInvalid(
      'Serialized plan target component digest is malformed.',
    );
  }

  if (role !== 'requirement-clause' && role !== 'policy') {
    const expectedIdentity = sha256(
      canonicalJson({
        schema: 'plan-target-component-identity.v1',
        kind,
        role,
        path: componentPath,
      }),
    );
    if (value.identityDigest !== expectedIdentity) {
      throw targetInvalid(
        'Serialized plan target component identity does not match its role and path.',
      );
    }
  }

  return {
    kind,
    role,
    path: componentPath,
    identityDigest: value.identityDigest,
    componentDigest: value.componentDigest,
  };
}

function assertComponentPath(
  role: ComponentRole,
  value: unknown,
  changeId: string,
): string {
  const componentPath = assertRepositorySafePath(value);
  const changeRoot = `openspec/changes/${changeId}`;
  const fixedPaths: Partial<Record<ComponentRole, string>> = {
    'schema-metadata': `${changeRoot}/.openspec.yaml`,
    proposal: `${changeRoot}/proposal.md`,
    design: `${changeRoot}/design.md`,
    tasks: `${changeRoot}/tasks.md`,
    guard: `${changeRoot}/guard.json`,
    execution: `${changeRoot}/execution.json`,
    investigation: `${changeRoot}/investigation.json`,
  };
  const fixedPath = fixedPaths[role];
  if (fixedPath !== undefined && componentPath !== fixedPath) {
    throw targetInvalid(
      `Plan target ${role} component path is not role-consistent.`,
    );
  }
  if (
    (role === 'delta-spec' || role === 'requirement-clause') &&
    !isDeltaSpecPath(componentPath, changeRoot)
  ) {
    throw targetInvalid(
      `Plan target ${role} component path is not role-consistent.`,
    );
  }
  if (role === 'policy' && !componentPath.startsWith('workflow/')) {
    throw targetInvalid(
      'Plan target policy component path is not role-consistent.',
    );
  }
  return componentPath;
}

function assertRepositorySafePath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.includes('\\') ||
    hasControlCharacter(value) ||
    WINDOWS_ABSOLUTE_PATTERN.test(value) ||
    UNSUPPORTED_PATH_GLOB_PATTERN.test(value) ||
    path.posix.normalize(value) !== value ||
    value
      .split('/')
      .some(
        (segment) =>
          segment.length === 0 ||
          segment === '.' ||
          segment === '..' ||
          segment.toLowerCase() === '.git',
      )
  ) {
    throw targetInvalid(
      'Plan target component path must be a canonical repository-relative path.',
    );
  }
  return value;
}

function isDeltaSpecPath(candidate: string, changeRoot: string): boolean {
  const prefix = `${changeRoot}/specs/`;
  if (!candidate.startsWith(prefix) || !candidate.endsWith('/spec.md')) {
    return false;
  }
  const capability = candidate.slice(prefix.length, -'/spec.md'.length);
  return (
    capability.length > 0 &&
    capability.split('/').every((segment) => CHANGE_ID_PATTERN.test(segment))
  );
}

function isHeadingIdentity(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    !hasControlCharacter(value)
  );
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function assertContent(value: unknown): string {
  if (typeof value !== 'string') {
    throw targetInvalid('Plan target component content must be a string.');
  }
  return value;
}

function normalizeLf(content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function normalizeTaskCompletion(content: string): string {
  return content.replace(TASK_CHECKBOX_PATTERN, '$1 $2');
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): void {
  if (!hasExactKeys(value, keys)) {
    throw targetInvalid('Plan target component has unexpected keys.');
  }
}

function assertComponentCardinality(
  roleCounts: ReadonlyMap<ComponentRole, number>,
): void {
  for (const [role, rule] of Object.entries(COMPONENT_RULES)) {
    const count = roleCounts.get(role as ComponentRole) ?? 0;
    if (rule.cardinality === 'one' && count !== 1) {
      throw targetInvalid(
        `Plan target requires exactly one ${role} component.`,
      );
    }
    if (rule.cardinality === 'many' && count < 1) {
      throw targetInvalid(
        `Plan target requires at least one ${role} component.`,
      );
    }
  }
}

function assertCanonicalComponentOrder(
  views: readonly PlanTargetComponentView[],
): void {
  for (let index = 1; index < views.length; index += 1) {
    if (compareComponentViews(views[index - 1]!, views[index]!) >= 0) {
      throw targetInvalid(
        'Serialized plan target components are not canonically ordered.',
      );
    }
  }
}

function componentLocationKey(view: PlanTargetComponentView): string {
  return canonicalJson([view.role, view.path]);
}

function compareComponentViews(
  left: PlanTargetComponentView,
  right: PlanTargetComponentView,
): number {
  return compareUtf8(
    canonicalJson([left.role, left.path, left.identityDigest]),
    canonicalJson([right.role, right.path, right.identityDigest]),
  );
}

function compareSourceNodes(
  left: PlanTargetSourceNode,
  right: PlanTargetSourceNode,
): number {
  return compareUtf8(
    canonicalJson([left.nodeId, left.resultDigest]),
    canonicalJson([right.nodeId, right.resultDigest]),
  );
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function planTargetDigest(
  value: Pick<
    PlanTarget,
    'schemaVersion' | 'changeId' | 'schemaName' | 'components'
  >,
): string {
  return sha256(
    canonicalJson({
      schema: TARGET_SCHEMA,
      schemaVersion: value.schemaVersion,
      changeId: value.changeId,
      schemaName: value.schemaName,
      components: value.components.map((component) => ({
        kind: component.kind,
        role: component.role,
        path: component.path,
        identityDigest: component.identityDigest,
        componentDigest: component.componentDigest,
      })),
    }),
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isDenseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes('length')) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      return false;
    }
  }
  return true;
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST_PATTERN.test(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const own = Reflect.ownKeys(value);
  return (
    own.length === keys.length &&
    own.every((key) => typeof key === 'string') &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return Boolean(
        descriptor && descriptor.enumerable && 'value' in descriptor,
      );
    })
  );
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function targetInvalid(message: string) {
  return workflowError('PLAN_TARGET_INVALID', message, ExitCode.usage);
}
