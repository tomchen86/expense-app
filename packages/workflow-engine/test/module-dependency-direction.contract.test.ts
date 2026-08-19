import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

const EXPECTED_MAP_ROWS = 280;
const EXPECTED_FROZEN_MAP_DIGEST =
  'sha256:8ef62fbb0658d245e4fe068659709538ae3e3ac6757cbb8e5e69672f02beafc7';
const EXPECTED_FROZEN_EDGE_COUNT = 774;
const EXPECTED_FROZEN_IDENTITY_DIGEST =
  'sha256:6c60e39c31cb378f79d8ed9f5f78f80cd85b38423c7210617eb413a86b757ad1';
const SRC_PREFIX = 'packages/workflow-engine/src/';
const BOOTSTRAP_PREFIX = 'packages/workflow-engine/bootstrap/';
const MAP_FILE = 'workflow-engine-module-map.tsv';
const BASELINE_FILE = 'module-dependency-baseline.json';
const ORGANIZED_ROOTS = new Set([
  'adapters',
  'application',
  'composition-root',
  'entrypoints',
  'foundation',
  'modules',
  'runtime',
]);
const KNOWN_DISPOSITIONS = new Set([
  'KEEP_BOOTSTRAP',
  'KEEP_RECOVERY',
  'KEEP_STABLE_ENTRYPOINT',
  'MOVE',
  'MOVE_PRIMARY_OWNER_MIXED',
]);
const GREEN_ORGANIZED_SOURCE = `${SRC_PREFIX}modules/source/generated-module-boundary-contract.ts`;

const KNOWN_RULES = new Set([
  'adapter-to-application',
  'adapter-to-composition-root',
  'adapter-to-entrypoints',
  'adapter-to-runtime',
  'application-to-adapters',
  'application-to-composition-root',
  'application-to-entrypoints',
  'application-to-runtime',
  'cross-adapter',
  'entrypoint-bypass-composition-root',
  'module-to-adapters',
  'module-to-application',
  'module-to-composition-root',
  'module-to-entrypoints',
  'module-to-runtime',
  'organized-to-stable',
  'runtime-to-adapters',
  'runtime-to-application',
  'runtime-to-composition-root',
  'runtime-to-entrypoints',
  'src-to-bootstrap',
  'why-to-investigation',
]);

type MapRow = {
  source: string;
  target: string;
  disposition: string;
};

type Reason = {
  summary: string;
  retirementPhase: string;
};

type BaselineEdge = {
  from: string;
  to: string;
  rule: string;
  reasonId: string;
  retirementPhase: string;
  status: 'active' | 'retired';
};

type Baseline = {
  kind: 'workflow-engine-module-dependency-baseline.v1';
  schemaVersion: 1;
  frozenEdgeCount: number;
  frozenIdentityDigest: string;
  reasonCatalog: Record<string, Reason>;
  edges: BaselineEdge[];
};

type ObservedEdge = Pick<BaselineEdge, 'from' | 'to' | 'rule'>;
type Snapshot = ReadonlyMap<string, string>;
type MutableSnapshot = Map<string, string>;

type SnapshotTopology = {
  selectedLegacy: Map<string, string>;
  organizedAdditions: string[];
};

type ImportedFile = {
  fileName: string;
  pos: number;
  end: number;
};

type TypeScriptApi = {
  preProcessFile(
    sourceText: string,
    readImportFiles?: boolean,
    detectJavaScriptImports?: boolean,
  ): { importedFiles: readonly ImportedFile[] };
};

const repositoryRoot = resolveRepositoryRoot(
  process.env.WORKFLOW_ENGINE_REPOSITORY_ROOT,
);
const repositoryRequire = createRequire(
  path.join(repositoryRoot, 'package.json'),
);
const ts = repositoryRequire('typescript') as TypeScriptApi;
const mapPath = resolveAssetPath(
  process.env.WORKFLOW_ENGINE_MODULE_MAP,
  MAP_FILE,
);
const baselinePath = resolveAssetPath(
  process.env.WORKFLOW_ENGINE_MODULE_BASELINE,
  BASELINE_FILE,
);

const moduleMapSource = fs.readFileSync(mapPath, 'utf8');
const moduleMap = parseFrozenModuleMap(moduleMapSource);
const baseline = parseBaseline(fs.readFileSync(baselinePath, 'utf8'));

test('module map and exact dependency baseline are frozen', () => {
  assert.equal(moduleMap.length, EXPECTED_MAP_ROWS);
  assert.equal(digestText(moduleMapSource), EXPECTED_FROZEN_MAP_DIGEST);
  assert.equal(baseline.edges.length, EXPECTED_FROZEN_EDGE_COUNT);
  assert.equal(baseline.frozenIdentityDigest, EXPECTED_FROZEN_IDENTITY_DIGEST);
  assert.equal(
    baseline.edges.filter((edge) => edge.status === 'active').length,
    EXPECTED_FROZEN_EDGE_COUNT,
  );
});

test('module map target and disposition mutations fail closed', () => {
  const targetMutation = moduleMapSource.replace(
    'foundation/canonical-json/canonical-json.ts',
    'foundation/canonical-json/canonical-json-renamed.ts',
  );
  assert.notEqual(targetMutation, moduleMapSource);
  assert.throws(
    () => parseFrozenModuleMap(targetMutation),
    /module map identity digest/i,
  );

  const allowedDispositionMutation = moduleMapSource.replace(
    '\tMOVE\n',
    '\tMOVE_PRIMARY_OWNER_MIXED\n',
  );
  assert.notEqual(allowedDispositionMutation, moduleMapSource);
  assert.throws(
    () => parseFrozenModuleMap(allowedDispositionMutation),
    /module map identity digest/i,
  );

  const unknownDispositionMutation = moduleMapSource.replace(
    '\tMOVE\n',
    '\tMOVE_UNKNOWN\n',
  );
  assert.notEqual(unknownDispositionMutation, moduleMapSource);
  assert.throws(
    () => parseModuleMap(unknownDispositionMutation),
    /unknown module map disposition/i,
  );
});

test('direction classifier accepts inward edges and rejects every protected reverse form', () => {
  assert.equal(
    classifyLogicalEdge(
      `${SRC_PREFIX}composition-root/root.ts`,
      `${SRC_PREFIX}application/propose/use-case.ts`,
    ),
    null,
  );
  assert.equal(
    classifyLogicalEdge(
      `${SRC_PREFIX}modules/investigation/domain/query.ts`,
      `${SRC_PREFIX}modules/why-knowledge/answer.ts`,
    ),
    null,
  );
  assert.equal(
    classifyLogicalEdge(
      `${SRC_PREFIX}modules/investigation/domain/query.ts`,
      `${SRC_PREFIX}runtime/storage-journal/store.ts`,
    ),
    'module-to-runtime',
  );
  assert.equal(
    classifyLogicalEdge(
      `${SRC_PREFIX}modules/why-knowledge/answer.ts`,
      `${SRC_PREFIX}modules/investigation/domain/query.ts`,
    ),
    'why-to-investigation',
  );
  assert.equal(
    classifyLogicalEdge(
      `${SRC_PREFIX}adapters/consumer/expense-app/reader.ts`,
      `${SRC_PREFIX}adapters/planning/openspec/writer.ts`,
    ),
    'cross-adapter',
  );
  assert.equal(
    classifyLogicalEdge(
      `${SRC_PREFIX}entrypoints/cli/run.ts`,
      `${SRC_PREFIX}modules/lifecycle/state.ts`,
    ),
    'entrypoint-bypass-composition-root',
  );
});

test('baseline rejects growth, replacement, duplicate identities, and wildcard paths', () => {
  const duplicate = cloneBaseline(baseline);
  duplicate.edges.push(structuredClone(duplicate.edges[0]!));
  duplicate.edges.sort(compareBaselineEdges);
  assert.throws(
    () => assertBaselineShape(duplicate),
    /duplicate baseline edge/i,
  );

  const growth = cloneBaseline(baseline);
  const reasonId = growth.edges[0]!.reasonId;
  const reason = growth.reasonCatalog[reasonId]!;
  growth.edges.push({
    from: `${SRC_PREFIX}modules/source/new-importer.ts`,
    to: `${SRC_PREFIX}runtime/storage-journal/new-target.ts`,
    rule: 'module-to-runtime',
    reasonId,
    retirementPhase: reason.retirementPhase,
    status: 'active',
  });
  growth.edges.sort(compareBaselineEdges);
  assert.throws(() => assertBaselineShape(growth), /frozen edge count/i);

  const replacement = cloneBaseline(baseline);
  replacement.edges[0]!.to = `${SRC_PREFIX}runtime/storage-journal/replacement.ts`;
  replacement.edges.sort(compareBaselineEdges);
  assert.throws(
    () => assertBaselineShape(replacement),
    /frozen identity digest/i,
  );

  const wildcard = cloneBaseline(baseline);
  wildcard.edges[0]!.from = `${SRC_PREFIX}modules/**/*.ts`;
  assert.throws(() => assertBaselineShape(wildcard), /exact TypeScript path/i);
});

test('matching rejects unlisted, stale, and retired-reappearing violations', () => {
  const observed = baseline.edges.map(observedEdge);

  const unlisted = [
    ...observed,
    {
      from: `${SRC_PREFIX}modules/source/new-importer.ts`,
      to: `${SRC_PREFIX}runtime/storage-journal/new-target.ts`,
      rule: 'module-to-runtime',
    },
  ].sort(compareObservedEdges);
  assert.throws(
    () => assertObservedMatchesBaseline(unlisted, baseline),
    /unlisted dependency violation/i,
  );

  assert.throws(
    () => assertObservedMatchesBaseline(observed.slice(1), baseline),
    /stale active baseline edge/i,
  );

  const retired = cloneBaseline(baseline);
  retired.edges[0]!.status = 'retired';
  assertBaselineShape(retired);
  assert.throws(
    () => assertObservedMatchesBaseline(observed, retired),
    /retired baseline edge reappeared/i,
  );
});

test('current repository matches the exact 774-edge active baseline', () => {
  const current = readRepositorySnapshot(repositoryRoot);
  const violations = scanViolations(current, moduleMap, {
    requireFinal: false,
  });
  assert.equal(violations.length, EXPECTED_FROZEN_EDGE_COUNT);
  assertObservedMatchesBaseline(violations, baseline);
});

test('a new file under a recognized organized root is scanned with self identity', () => {
  const current = withGreenOrganizedSource(
    readRepositorySnapshot(repositoryRoot),
  );
  const violations = scanViolations(current, moduleMap, {
    requireFinal: false,
  });
  assert.equal(violations.length, EXPECTED_FROZEN_EDGE_COUNT);
  assertObservedMatchesBaseline(violations, baseline);
});

test('new flat sources and unknown organized roots fail topology validation', () => {
  const current = readRepositorySnapshot(repositoryRoot);

  const flat = new Map(current);
  flat.set(`${SRC_PREFIX}new-unmapped-flat.ts`, 'export const value = true;\n');
  assert.throws(
    () => scanViolations(flat, moduleMap, { requireFinal: false }),
    /unknown flat top-level source/i,
  );

  const unknownRoot = new Map(current);
  unknownRoot.set(
    `${SRC_PREFIX}unrecognized-root/new-source.ts`,
    'export const value = true;\n',
  );
  assert.throws(
    () => scanViolations(unknownRoot, moduleMap, { requireFinal: false }),
    /unknown organized source root/i,
  );
});

test('a forbidden edge from a new organized file is unlisted and fails closed', () => {
  const current = new Map(readRepositorySnapshot(repositoryRoot));
  current.set(
    `${SRC_PREFIX}modules/source/generated-forbidden-edge.ts`,
    [
      'import { runtimePaths } from "../../session-store.ts";',
      'export { runtimePaths };',
      '',
    ].join('\n'),
  );
  const violations = scanViolations(current, moduleMap, {
    requireFinal: false,
  });
  assert.equal(violations.length, EXPECTED_FROZEN_EDGE_COUNT + 1);
  assert.throws(
    () => assertObservedMatchesBaseline(violations, baseline),
    /unlisted dependency violation.*generated-forbidden-edge.*module-to-runtime/i,
  );
});

test('partial migration canonicalizes old and new physical paths to the same graph', () => {
  const current = withGreenOrganizedSource(
    readRepositorySnapshot(repositoryRoot),
  );
  const expected = scanViolations(current, moduleMap, { requireFinal: false });
  const partial = buildMigratedSnapshot(
    current,
    moduleMap,
    (row, index) => row.source !== row.target && index % 2 === 0,
  );
  const observed = scanViolations(partial, moduleMap, { requireFinal: false });
  assert.deepEqual(observed, expected);
  assertObservedMatchesBaseline(observed, baseline);
});

test('fully moved snapshot preserves the canonical graph and exact baseline', () => {
  const current = withGreenOrganizedSource(
    readRepositorySnapshot(repositoryRoot),
  );
  const expected = scanViolations(current, moduleMap, { requireFinal: false });
  const moved = buildMigratedSnapshot(
    current,
    moduleMap,
    (row) => row.source !== row.target,
  );
  const observed = scanViolations(moved, moduleMap, { requireFinal: true });
  assert.deepEqual(observed, expected);
  assertObservedMatchesBaseline(observed, baseline);
});

function resolveRepositoryRoot(explicit: string | undefined): string {
  if (explicit) {
    const resolved = fs.realpathSync(explicit);
    assertRepositoryRoot(resolved);
    return resolved;
  }
  let cursor = fs.realpathSync(import.meta.dirname);
  while (true) {
    if (
      fs.existsSync(path.join(cursor, 'package.json')) &&
      fs.existsSync(path.join(cursor, 'packages/workflow-engine/package.json'))
    ) {
      return cursor;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      throw new Error(
        'Set WORKFLOW_ENGINE_REPOSITORY_ROOT when the prototype is outside the repository.',
      );
    }
    cursor = parent;
  }
}

function assertRepositoryRoot(root: string): void {
  if (
    !fs.statSync(path.join(root, 'package.json')).isFile() ||
    !fs
      .statSync(path.join(root, 'packages/workflow-engine/package.json'))
      .isFile()
  ) {
    throw new Error(`Not a workflow-engine repository root: ${root}`);
  }
}

function resolveAssetPath(explicit: string | undefined, name: string): string {
  if (explicit) {
    return fs.realpathSync(explicit);
  }
  const candidates = [
    path.join(import.meta.dirname, name),
    path.join(import.meta.dirname, 'fixtures', name),
  ];
  const observed = candidates.find((candidate) => fs.existsSync(candidate));
  if (!observed) {
    throw new Error(`Missing module-boundary asset: ${name}`);
  }
  return fs.realpathSync(observed);
}

function parseFrozenModuleMap(text: string): MapRow[] {
  if (digestText(text) !== EXPECTED_FROZEN_MAP_DIGEST) {
    throw new Error(
      'Module map identity digest does not match the frozen map.',
    );
  }
  return parseModuleMap(text);
}

function parseModuleMap(text: string): MapRow[] {
  const lines = text.trimEnd().split('\n');
  if (lines.shift() !== 'source\ttarget\tdisposition') {
    throw new Error('Module map header is invalid.');
  }
  const rows = lines.map((line, index) => {
    const fields = line.split('\t');
    if (fields.length !== 3 || fields.some((field) => field.length === 0)) {
      throw new Error(`Module map row ${index + 2} is invalid.`);
    }
    const [source, target, disposition] = fields;
    assertExactTypeScriptPath(source!, 'map source');
    assertExactTypeScriptPath(target!, 'map target');
    if (!source!.startsWith(SRC_PREFIX) || !target!.startsWith(SRC_PREFIX)) {
      throw new Error('Module map paths must remain in workflow-engine src.');
    }
    if (!KNOWN_DISPOSITIONS.has(disposition!)) {
      throw new Error(`Unknown module map disposition: ${disposition}`);
    }
    return { source: source!, target: target!, disposition: disposition! };
  });

  const sources = new Set<string>();
  const targets = new Set<string>();
  const physicalOwners = new Map<string, string>();
  for (const row of rows) {
    if (sources.has(row.source)) {
      throw new Error(`Duplicate module map source: ${row.source}`);
    }
    if (targets.has(row.target)) {
      throw new Error(`Duplicate module map target: ${row.target}`);
    }
    sources.add(row.source);
    targets.add(row.target);
    for (const physical of new Set([row.source, row.target])) {
      const owner = physicalOwners.get(physical);
      if (owner && owner !== row.source) {
        throw new Error(`Module map physical path collision: ${physical}`);
      }
      physicalOwners.set(physical, row.source);
    }
  }
  return rows;
}

function parseBaseline(text: string): Baseline {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error('Dependency baseline is malformed JSON.', { cause: error });
  }
  return assertBaselineShape(value);
}

function assertBaselineShape(value: unknown): Baseline {
  assertPlainObject(value, 'Dependency baseline');
  assertExactKeys(value, [
    'edges',
    'frozenEdgeCount',
    'frozenIdentityDigest',
    'kind',
    'reasonCatalog',
    'schemaVersion',
  ]);
  if (
    value.kind !== 'workflow-engine-module-dependency-baseline.v1' ||
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.frozenEdgeCount) ||
    typeof value.frozenIdentityDigest !== 'string' ||
    !Array.isArray(value.edges)
  ) {
    throw new Error('Dependency baseline header is invalid.');
  }
  assertPlainObject(value.reasonCatalog, 'Reason catalog');

  const reasonCatalog: Record<string, Reason> = {};
  for (const [reasonId, reasonValue] of Object.entries(value.reasonCatalog)) {
    if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(reasonId)) {
      throw new Error(`Invalid dependency reason ID: ${reasonId}`);
    }
    assertPlainObject(reasonValue, `Reason ${reasonId}`);
    assertExactKeys(reasonValue, ['retirementPhase', 'summary']);
    if (
      typeof reasonValue.summary !== 'string' ||
      reasonValue.summary.length === 0 ||
      typeof reasonValue.retirementPhase !== 'string' ||
      reasonValue.retirementPhase.length === 0
    ) {
      throw new Error(`Dependency reason ${reasonId} is invalid.`);
    }
    reasonCatalog[reasonId] = {
      summary: reasonValue.summary,
      retirementPhase: reasonValue.retirementPhase,
    };
  }

  const edges: BaselineEdge[] = value.edges.map((edgeValue, index) => {
    assertPlainObject(edgeValue, `Baseline edge ${index + 1}`);
    assertExactKeys(edgeValue, [
      'from',
      'reasonId',
      'retirementPhase',
      'rule',
      'status',
      'to',
    ]);
    assertExactTypeScriptPath(edgeValue.from, 'baseline from');
    assertExactTypeScriptPath(edgeValue.to, 'baseline to');
    if (
      typeof edgeValue.rule !== 'string' ||
      !KNOWN_RULES.has(edgeValue.rule) ||
      typeof edgeValue.reasonId !== 'string' ||
      typeof edgeValue.retirementPhase !== 'string' ||
      (edgeValue.status !== 'active' && edgeValue.status !== 'retired')
    ) {
      throw new Error(`Baseline edge ${index + 1} is invalid.`);
    }
    const reason = reasonCatalog[edgeValue.reasonId];
    if (!reason || reason.retirementPhase !== edgeValue.retirementPhase) {
      throw new Error(`Baseline edge ${index + 1} has an invalid reason.`);
    }
    return {
      from: edgeValue.from,
      to: edgeValue.to,
      rule: edgeValue.rule,
      reasonId: edgeValue.reasonId,
      retirementPhase: edgeValue.retirementPhase,
      status: edgeValue.status,
    };
  });

  const identities = new Set<string>();
  for (const edge of edges) {
    const identity = edgeIdentity(edge);
    if (identities.has(identity)) {
      throw new Error(`Duplicate baseline edge: ${identity}`);
    }
    identities.add(identity);
  }
  for (let index = 1; index < edges.length; index += 1) {
    if (compareBaselineEdges(edges[index - 1]!, edges[index]!) >= 0) {
      throw new Error('Dependency baseline edges are not canonically sorted.');
    }
  }
  if (
    value.frozenEdgeCount !== EXPECTED_FROZEN_EDGE_COUNT ||
    edges.length !== EXPECTED_FROZEN_EDGE_COUNT
  ) {
    throw new Error(
      `Dependency baseline frozen edge count must remain ${EXPECTED_FROZEN_EDGE_COUNT}.`,
    );
  }
  const identityDigest = digestEdgeIdentities(edges);
  if (
    value.frozenIdentityDigest !== EXPECTED_FROZEN_IDENTITY_DIGEST ||
    identityDigest !== EXPECTED_FROZEN_IDENTITY_DIGEST
  ) {
    throw new Error('Dependency baseline frozen identity digest changed.');
  }
  return {
    kind: 'workflow-engine-module-dependency-baseline.v1',
    schemaVersion: 1,
    frozenEdgeCount: value.frozenEdgeCount,
    frozenIdentityDigest: value.frozenIdentityDigest,
    reasonCatalog,
    edges,
  };
}

function assertObservedMatchesBaseline(
  observed: readonly ObservedEdge[],
  expected: Baseline,
): void {
  const active = new Map<string, BaselineEdge>();
  const retired = new Map<string, BaselineEdge>();
  for (const edge of expected.edges) {
    (edge.status === 'active' ? active : retired).set(edgeIdentity(edge), edge);
  }
  const observedIdentities = new Set(observed.map(edgeIdentity));
  for (const edge of observed) {
    const identity = edgeIdentity(edge);
    if (retired.has(identity)) {
      throw new Error(`Retired baseline edge reappeared: ${identity}`);
    }
    if (!active.has(identity)) {
      throw new Error(`Unlisted dependency violation: ${identity}`);
    }
  }
  for (const identity of active.keys()) {
    if (!observedIdentities.has(identity)) {
      throw new Error(`Stale active baseline edge: ${identity}`);
    }
  }
}

function readRepositorySnapshot(root: string): MutableSnapshot {
  const snapshot = new Map<string, string>();
  readTypeScriptTree(root, path.join(root, ...SRC_PREFIX.split('/')), snapshot);
  readTypeScriptTree(
    root,
    path.join(root, ...BOOTSTRAP_PREFIX.split('/')),
    snapshot,
  );
  return snapshot;
}

function withGreenOrganizedSource(snapshot: Snapshot): MutableSnapshot {
  const extended = new Map(snapshot);
  const actorIdentity = moduleMap.find(
    (row) => row.source === `${SRC_PREFIX}actor-identity.ts`,
  );
  assert.ok(actorIdentity, 'actor identity must remain in the migration map');
  const physicalCandidates = [
    actorIdentity.source,
    actorIdentity.target,
  ].filter((candidate) => snapshot.has(candidate));
  assert.equal(
    physicalCandidates.length,
    1,
    'actor identity must have one current physical path',
  );
  let actorSpecifier = path.posix.relative(
    path.posix.dirname(GREEN_ORGANIZED_SOURCE),
    physicalCandidates[0]!,
  );
  if (!actorSpecifier.startsWith('.')) {
    actorSpecifier = `./${actorSpecifier}`;
  }
  extended.set(
    GREEN_ORGANIZED_SOURCE,
    [
      `import type { ActorResolution } from "${actorSpecifier}";`,
      'export type GeneratedActorResolution = ActorResolution;',
      '',
    ].join('\n'),
  );
  return extended;
}

function readTypeScriptTree(
  repository: string,
  directory: string,
  snapshot: MutableSnapshot,
): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Module-boundary scan refuses symlink: ${absolute}`);
    }
    if (entry.isDirectory()) {
      readTypeScriptTree(repository, absolute, snapshot);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      const relative = path
        .relative(repository, absolute)
        .split(path.sep)
        .join('/');
      snapshot.set(relative, fs.readFileSync(absolute, 'utf8'));
    }
  }
}

function scanViolations(
  snapshot: Snapshot,
  rows: readonly MapRow[],
  options: { requireFinal: boolean },
): ObservedEdge[] {
  const topology = assertSnapshotTopology(snapshot, rows, options);
  const canonicalByPhysical = canonicalPhysicalMap(rows);
  const observed = new Map<string, ObservedEdge>();
  const scanUnits = [
    ...rows.map((row) => ({
      physicalFrom: topology.selectedLegacy.get(row.source)!,
      logicalFrom: row.target,
    })),
    ...topology.organizedAdditions.map((file) => ({
      physicalFrom: file,
      logicalFrom: file,
    })),
  ];

  for (const { physicalFrom, logicalFrom } of scanUnits) {
    const sourceText = snapshot.get(physicalFrom)!;
    const imports = ts.preProcessFile(sourceText, true, true).importedFiles;
    for (const imported of imports) {
      if (!imported.fileName.startsWith('.')) {
        continue;
      }
      const physicalTo = resolveLocalImport(
        physicalFrom,
        imported.fileName,
        snapshot,
      );
      const targetRow = canonicalByPhysical.get(physicalTo);
      let logicalTo: string;
      if (targetRow) {
        logicalTo = targetRow.target;
      } else if (isRecognizedOrganizedSourcePath(physicalTo)) {
        logicalTo = physicalTo;
      } else if (physicalTo.startsWith(BOOTSTRAP_PREFIX)) {
        logicalTo = physicalTo;
      } else {
        throw new Error(
          `Organized source imported unclassified local path: ${physicalFrom} -> ${physicalTo}`,
        );
      }
      const rule = classifyLogicalEdge(logicalFrom, logicalTo);
      if (rule) {
        const edge = { from: logicalFrom, to: logicalTo, rule };
        observed.set(edgeIdentity(edge), edge);
      }
    }
  }
  return [...observed.values()].sort(compareObservedEdges);
}

function assertSnapshotTopology(
  snapshot: Snapshot,
  rows: readonly MapRow[],
  options: { requireFinal: boolean },
): SnapshotTopology {
  const selected = new Map<string, string>();
  const ownedPhysicalPaths = new Set<string>();
  for (const row of rows) {
    const candidates = [...new Set([row.source, row.target])];
    const present = candidates.filter((candidate) => snapshot.has(candidate));
    if (present.length !== 1) {
      throw new Error(
        `Module map row must have exactly one physical path: ${row.source} -> ${row.target}`,
      );
    }
    if (options.requireFinal && present[0] !== row.target) {
      throw new Error(
        `Legacy module source remains after final move: ${row.source}`,
      );
    }
    selected.set(row.source, present[0]!);
    ownedPhysicalPaths.add(present[0]!);
  }
  const actualSourcePaths = [...snapshot.keys()]
    .filter((file) => file.startsWith(SRC_PREFIX) && file.endsWith('.ts'))
    .sort();
  const organizedAdditions = actualSourcePaths.filter(
    (file) => !ownedPhysicalPaths.has(file),
  );
  for (const file of organizedAdditions) {
    const relative = file.slice(SRC_PREFIX.length);
    const parts = relative.split('/');
    if (parts.length === 1) {
      throw new Error(`Unknown flat top-level source: ${file}`);
    }
    if (!ORGANIZED_ROOTS.has(parts[0]!)) {
      throw new Error(`Unknown organized source root: ${file}`);
    }
  }
  return { selectedLegacy: selected, organizedAdditions };
}

function canonicalPhysicalMap(rows: readonly MapRow[]): Map<string, MapRow> {
  const result = new Map<string, MapRow>();
  for (const row of rows) {
    for (const physical of new Set([row.source, row.target])) {
      const existing = result.get(physical);
      if (existing && existing.source !== row.source) {
        throw new Error(`Module map physical path collision: ${physical}`);
      }
      result.set(physical, row);
    }
  }
  return result;
}

function resolveLocalImport(
  physicalFrom: string,
  specifier: string,
  snapshot: Snapshot,
): string {
  const unresolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(physicalFrom), specifier),
  );
  const candidates = [
    unresolved,
    unresolved.replace(/\.js$/, '.ts'),
    `${unresolved}.ts`,
    path.posix.join(unresolved, 'index.ts'),
  ];
  const resolved = candidates.find((candidate) => snapshot.has(candidate));
  if (!resolved) {
    throw new Error(`Unresolved local import: ${physicalFrom} -> ${specifier}`);
  }
  return resolved;
}

function buildMigratedSnapshot(
  current: Snapshot,
  rows: readonly MapRow[],
  shouldMove: (row: MapRow, index: number) => boolean,
): MutableSnapshot {
  const currentTopology = assertSnapshotTopology(current, rows, {
    requireFinal: false,
  });
  const currentCanonical = canonicalPhysicalMap(rows);
  const desiredBySource = new Map<string, string>();
  rows.forEach((row, index) => {
    desiredBySource.set(
      row.source,
      row.source === row.target || shouldMove(row, index)
        ? row.target
        : row.source,
    );
  });

  const migrated = new Map<string, string>();
  for (const [file, content] of current) {
    if (file.startsWith(BOOTSTRAP_PREFIX)) {
      migrated.set(file, content);
    }
  }
  for (const row of rows) {
    const physicalFrom = currentTopology.selectedLegacy.get(row.source)!;
    const desiredFrom = desiredBySource.get(row.source)!;
    const sourceText = current.get(physicalFrom)!;
    migrated.set(
      desiredFrom,
      rewriteRelativeImports(
        sourceText,
        physicalFrom,
        desiredFrom,
        current,
        currentCanonical,
        desiredBySource,
      ),
    );
  }
  for (const organizedAddition of currentTopology.organizedAdditions) {
    migrated.set(
      organizedAddition,
      rewriteRelativeImports(
        current.get(organizedAddition)!,
        organizedAddition,
        organizedAddition,
        current,
        currentCanonical,
        desiredBySource,
      ),
    );
  }
  return migrated;
}

function rewriteRelativeImports(
  sourceText: string,
  physicalFrom: string,
  desiredFrom: string,
  current: Snapshot,
  currentCanonical: ReadonlyMap<string, MapRow>,
  desiredBySource: ReadonlyMap<string, string>,
): string {
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  for (const imported of ts.preProcessFile(sourceText, true, true)
    .importedFiles) {
    if (!imported.fileName.startsWith('.')) {
      continue;
    }
    const currentTarget = resolveLocalImport(
      physicalFrom,
      imported.fileName,
      current,
    );
    const targetRow = currentCanonical.get(currentTarget);
    const desiredTarget = targetRow
      ? desiredBySource.get(targetRow.source)!
      : currentTarget;
    let nextSpecifier = path.posix.relative(
      path.posix.dirname(desiredFrom),
      desiredTarget,
    );
    if (!nextSpecifier.startsWith('.')) {
      nextSpecifier = `./${nextSpecifier}`;
    }
    if (imported.fileName.endsWith('.js') && nextSpecifier.endsWith('.ts')) {
      nextSpecifier = `${nextSpecifier.slice(0, -3)}.js`;
    }
    const start = sourceText.indexOf(imported.fileName, imported.pos);
    if (start < 0 || start > imported.end + 2) {
      throw new Error(`Cannot locate import token in ${physicalFrom}.`);
    }
    replacements.push({
      start,
      end: start + imported.fileName.length,
      value: nextSpecifier,
    });
  }
  replacements.sort((left, right) => right.start - left.start);
  let rewritten = sourceText;
  for (const replacement of replacements) {
    rewritten =
      rewritten.slice(0, replacement.start) +
      replacement.value +
      rewritten.slice(replacement.end);
  }
  return rewritten;
}

function classifyLogicalEdge(from: string, to: string): string | null {
  const fromInfo = logicalPathInfo(from);
  if (fromInfo.layer === 'stable') {
    return null;
  }
  if (to.startsWith(BOOTSTRAP_PREFIX)) {
    return 'src-to-bootstrap';
  }
  const toInfo = logicalPathInfo(to);
  if (toInfo.layer === 'stable') {
    return 'organized-to-stable';
  }
  if (fromInfo.layer === toInfo.layer) {
    if (fromInfo.layer === 'adapters' && fromInfo.domain !== toInfo.domain) {
      return 'cross-adapter';
    }
    if (
      fromInfo.layer === 'modules' &&
      fromInfo.domain === 'modules/why-knowledge' &&
      toInfo.domain === 'modules/investigation'
    ) {
      return 'why-to-investigation';
    }
    return null;
  }
  if (toInfo.layer === 'foundation') {
    return null;
  }
  const allowed: Record<string, ReadonlySet<string>> = {
    entrypoints: new Set(['composition-root']),
    'composition-root': new Set([
      'application',
      'runtime',
      'adapters',
      'modules',
    ]),
    application: new Set(['modules']),
    runtime: new Set(['modules']),
    adapters: new Set(['modules']),
    modules: new Set(),
    foundation: new Set(),
  };
  if (allowed[fromInfo.layer]?.has(toInfo.layer)) {
    return null;
  }
  if (fromInfo.layer === 'entrypoints') {
    return 'entrypoint-bypass-composition-root';
  }
  if (fromInfo.layer === 'foundation') {
    return 'foundation-outward';
  }
  const prefix =
    fromInfo.layer === 'modules'
      ? 'module'
      : fromInfo.layer === 'adapters'
        ? 'adapter'
        : fromInfo.layer;
  return `${prefix}-to-${toInfo.layer}`;
}

function logicalPathInfo(file: string): { layer: string; domain: string } {
  if (!file.startsWith(SRC_PREFIX)) {
    throw new Error(`Logical dependency path is outside src: ${file}`);
  }
  const parts = file.slice(SRC_PREFIX.length).split('/');
  if (parts.length === 1) {
    return { layer: 'stable', domain: 'stable' };
  }
  return { layer: parts[0]!, domain: `${parts[0]}/${parts[1]}` };
}

function isRecognizedOrganizedSourcePath(file: string): boolean {
  if (!file.startsWith(SRC_PREFIX) || !file.endsWith('.ts')) {
    return false;
  }
  const parts = file.slice(SRC_PREFIX.length).split('/');
  return parts.length >= 2 && ORGANIZED_ROOTS.has(parts[0]!);
}

function assertExactTypeScriptPath(
  value: unknown,
  label: string,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    path.posix.isAbsolute(value) ||
    value.includes('\\') ||
    /[*?[\]{}]/.test(value) ||
    !value.endsWith('.ts') ||
    path.posix.normalize(value) !== value ||
    value
      .split('/')
      .some((part) => part.length === 0 || part === '.' || part === '..')
  ) {
    throw new Error(`${label} must be an exact TypeScript path.`);
  }
}

function assertPlainObject(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new Error(`${label} must be an object.`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
}

function edgeIdentity(edge: ObservedEdge): string {
  return `${edge.from}\t${edge.to}\t${edge.rule}`;
}

function digestEdgeIdentities(edges: readonly ObservedEdge[]): string {
  return `sha256:${crypto
    .createHash('sha256')
    .update(`${edges.map(edgeIdentity).join('\n')}\n`)
    .digest('hex')}`;
}

function digestText(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function compareObservedEdges(left: ObservedEdge, right: ObservedEdge): number {
  return edgeIdentity(left).localeCompare(edgeIdentity(right));
}

function compareBaselineEdges(left: BaselineEdge, right: BaselineEdge): number {
  return compareObservedEdges(left, right);
}

function observedEdge(edge: BaselineEdge): ObservedEdge {
  return { from: edge.from, to: edge.to, rule: edge.rule };
}

function cloneBaseline(value: Baseline): Baseline {
  return structuredClone(value);
}
