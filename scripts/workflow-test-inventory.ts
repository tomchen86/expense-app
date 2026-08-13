import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const WORKFLOW_TEST_SHARD_MANIFEST_PATH =
  'workflow/test-shards.json' as const;
export const WORKFLOW_TEST_SHARD_COUNT = 8 as const;
export const WORKFLOW_TEST_SHARD_MANIFEST_KIND =
  'workflow-test-shard-manifest.v1' as const;
export const WORKFLOW_TEST_SHARD_ALGORITHM = Object.freeze({
  name: 'longest-processing-time' as const,
  version: 1 as const,
  shardCount: WORKFLOW_TEST_SHARD_COUNT,
  telemetryNesting: 0 as const,
  durationUnit: 'milliseconds' as const,
  ordering:
    'duration-descending,legacy-ordinal-ascending,entrypoint-ascending' as const,
  placement: 'shard-duration-ascending,shard-number-ascending' as const,
});

const TEST_ROOT = 'packages/workflow-engine/test';
const CONTRACTS_ROOT = `${TEST_ROOT}/contracts.test.ts`;
const SESSION_ROOT = `${TEST_ROOT}/session.integration.test.ts`;
const ROOTS = Object.freeze([CONTRACTS_ROOT, SESSION_ROOT] as const);
const FAMILY_LOADERS = Object.freeze({
  [CONTRACTS_ROOT]: `${TEST_ROOT}/contracts-legacy-family.ts`,
  [SESSION_ROOT]: `${TEST_ROOT}/session-legacy-family.ts`,
});
const ROOT_OWN_TEST_COUNTS = Object.freeze({
  [CONTRACTS_ROOT]: 29,
  [SESSION_ROOT]: 24,
});
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

/**
 * These exceptions are intentionally tracked in code so a scratch directory
 * inside the checkout can never become an implicit concession.
 */
export const WORKFLOW_TEST_SCRATCH_SAFETY_EXCEPTIONS: readonly string[] =
  Object.freeze([
    // Contract fixture: this source contains the rejected text as test data.
    `${TEST_ROOT}/workflow-test-inventory.contract.test.ts`,
  ]);

export type WorkflowTestExecutionUnit = Readonly<{
  entrypoint: string;
  ownedPhysicalFiles: readonly string[];
  legacyOrdinal: number;
  estimatedDurationMs: number;
}>;

export type WorkflowTestShard = Readonly<{
  shardNumber: number;
  id: string;
  wrapper: string;
  estimatedDurationMs: number;
  units: readonly WorkflowTestExecutionUnit[];
}>;

export type WorkflowTestShardManifest = Readonly<{
  schemaVersion: 1;
  kind: typeof WORKFLOW_TEST_SHARD_MANIFEST_KIND;
  algorithm: typeof WORKFLOW_TEST_SHARD_ALGORITHM;
  sourceTelemetryRunId: string;
  sourceTelemetryDigest: `sha256:${string}`;
  physicalFileCount: number;
  executionUnitCount: number;
  inventoryDigest: `sha256:${string}`;
  shards: readonly WorkflowTestShard[];
}>;

export type FullGateCoverageExpectation = Readonly<{
  inventoryDigest: `sha256:${string}`;
  expectedFiles: readonly string[];
  expectedFileSetDigest: `sha256:${string}`;
}>;

export type WorkflowTestTopology = Readonly<{
  physicalFiles: readonly string[];
  units: readonly Readonly<{
    entrypoint: string;
    ownedPhysicalFiles: readonly string[];
  }>[];
}>;

export function loadWorkflowTestShardManifest(
  repositoryRoot: string,
): WorkflowTestShardManifest {
  const root = canonicalRepositoryRoot(repositoryRoot);
  const manifestPath = path.join(root, WORKFLOW_TEST_SHARD_MANIFEST_PATH);
  const stats = fs.lstatSync(manifestPath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error('Workflow test shard manifest must be a regular file.');
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error('Workflow test shard manifest is malformed JSON.', {
      cause: error,
    });
  }
  return validateWorkflowTestShardManifest(candidate, {
    repositoryRoot: root,
  });
}

export function validateWorkflowTestShardManifest(
  candidate: unknown,
  options: Readonly<{ repositoryRoot?: string }> = {},
): WorkflowTestShardManifest {
  const manifest = parseManifest(candidate);
  const physicalOwners = new Map<string, string>();
  const entrypoints = new Set<string>();
  const ordinals = new Set<number>();

  if (manifest.shards.length !== WORKFLOW_TEST_SHARD_COUNT) {
    throw new Error(
      `Workflow test shard manifest must declare ${WORKFLOW_TEST_SHARD_COUNT} shards.`,
    );
  }
  for (let index = 0; index < manifest.shards.length; index += 1) {
    const shard = manifest.shards[index]!;
    const shardNumber = index + 1;
    const expectedId = `shard-${String(shardNumber).padStart(2, '0')}`;
    const expectedWrapper = `${TEST_ROOT}/shards/${expectedId}.ts`;
    if (
      shard.shardNumber !== shardNumber ||
      shard.id !== expectedId ||
      shard.wrapper !== expectedWrapper
    ) {
      throw new Error(
        `Workflow test shard ${shardNumber} identity is invalid.`,
      );
    }
    let priorOrdinal = 0;
    let durationMicros = 0;
    for (const unit of shard.units) {
      assertWorkflowTestPath(unit.entrypoint);
      if (entrypoints.has(unit.entrypoint)) {
        throw new Error(
          `Duplicate workflow test entrypoint: ${unit.entrypoint}.`,
        );
      }
      entrypoints.add(unit.entrypoint);
      if (
        !Number.isSafeInteger(unit.legacyOrdinal) ||
        unit.legacyOrdinal < 1 ||
        ordinals.has(unit.legacyOrdinal)
      ) {
        throw new Error(
          `Workflow test legacy ordinal is invalid for ${unit.entrypoint}.`,
        );
      }
      if (unit.legacyOrdinal <= priorOrdinal) {
        throw new Error(`Workflow test shard ${shard.id} units are unordered.`);
      }
      priorOrdinal = unit.legacyOrdinal;
      ordinals.add(unit.legacyOrdinal);
      durationMicros += durationToMicros(
        unit.estimatedDurationMs,
        unit.entrypoint,
      );
      if (unit.ownedPhysicalFiles.length === 0) {
        throw new Error(
          `Workflow test unit ${unit.entrypoint} owns no physical files.`,
        );
      }
      if (
        compareStringArrays(
          unit.ownedPhysicalFiles,
          [...unit.ownedPhysicalFiles].sort(compareText),
        ) !== 0
      ) {
        throw new Error(
          `Workflow test unit ${unit.entrypoint} ownership is not canonical.`,
        );
      }
      if (!unit.ownedPhysicalFiles.includes(unit.entrypoint)) {
        throw new Error(
          `Workflow test unit ${unit.entrypoint} does not own its entrypoint.`,
        );
      }
      for (const physicalFile of unit.ownedPhysicalFiles) {
        assertWorkflowTestPath(physicalFile);
        const priorOwner = physicalOwners.get(physicalFile);
        if (priorOwner !== undefined) {
          throw new Error(
            `Duplicate physical test ownership: ${physicalFile} is owned by ${priorOwner} and ${unit.entrypoint}.`,
          );
        }
        physicalOwners.set(physicalFile, unit.entrypoint);
      }
    }
    if (microsToDuration(durationMicros) !== shard.estimatedDurationMs) {
      throw new Error(`Workflow test shard ${shard.id} duration is invalid.`);
    }
  }

  const allOrdinals = [...ordinals].sort((left, right) => left - right);
  if (
    allOrdinals.length !== manifest.executionUnitCount ||
    allOrdinals.some((ordinal, index) => ordinal !== index + 1)
  ) {
    throw new Error('Workflow test legacy ordinals must be contiguous.');
  }
  if (
    entrypoints.size !== manifest.executionUnitCount ||
    physicalOwners.size !== manifest.physicalFileCount
  ) {
    throw new Error(
      'Workflow test manifest counts do not match its inventory.',
    );
  }
  const projectedShards = assignWorkflowTestUnitsToShards(
    manifest.shards.flatMap((shard) => shard.units),
  );
  if (canonicalJson(manifest.shards) !== canonicalJson(projectedShards)) {
    throw new Error(
      'Workflow test shard assignment drifted from deterministic LPT.',
    );
  }

  const projectedDigest = digestWorkflowTestManifest(manifest);
  if (manifest.inventoryDigest !== projectedDigest) {
    throw new Error(
      `Workflow test inventory digest drift: expected ${projectedDigest}, observed ${manifest.inventoryDigest}.`,
    );
  }

  if (options.repositoryRoot !== undefined) {
    const repositoryRoot = canonicalRepositoryRoot(options.repositoryRoot);
    const topology = discoverWorkflowTestTopology(repositoryRoot);
    const expected = new Set(topology.physicalFiles);
    const observed = new Set(physicalOwners.keys());
    const missing = topology.physicalFiles.filter(
      (file) => !observed.has(file),
    );
    const unknown = [...observed].filter((file) => !expected.has(file)).sort();
    if (missing.length > 0) {
      throw new Error(
        `Missing physical workflow tests from shard ownership: ${missing.join(', ')}.`,
      );
    }
    if (unknown.length > 0) {
      throw new Error(
        `Unknown physical workflow tests in shard ownership: ${unknown.join(', ')}.`,
      );
    }
    const discoveredByEntrypoint = new Map(
      topology.units.map((unit) => [unit.entrypoint, unit.ownedPhysicalFiles]),
    );
    for (const shard of manifest.shards) {
      for (const unit of shard.units) {
        const discovered = discoveredByEntrypoint.get(unit.entrypoint);
        if (
          discovered === undefined ||
          compareStringArrays(discovered, unit.ownedPhysicalFiles) !== 0
        ) {
          throw new Error(
            `Workflow test ownership topology drifted at ${unit.entrypoint}.`,
          );
        }
        discoveredByEntrypoint.delete(unit.entrypoint);
      }
    }
    if (discoveredByEntrypoint.size > 0) {
      throw new Error(
        `Missing workflow test execution units: ${[...discoveredByEntrypoint.keys()].sort().join(', ')}.`,
      );
    }
    assertWorkflowTestShardWrappers(repositoryRoot, manifest);
  }

  return deepFreeze(manifest);
}

export function expectedPhysicalFiles(
  manifest: WorkflowTestShardManifest,
): readonly string[] {
  const files = manifest.shards.flatMap((shard) =>
    shard.units.flatMap((unit) => unit.ownedPhysicalFiles),
  );
  digestWorkflowTestFileSet(files);
  return Object.freeze([...files].sort(compareText));
}

export function workflowTestShardWrapperPaths(
  manifest: WorkflowTestShardManifest,
): readonly string[] {
  return Object.freeze(manifest.shards.map((shard) => shard.wrapper));
}

export function createFullGateCoverageExpectation(
  manifest: WorkflowTestShardManifest,
): FullGateCoverageExpectation {
  const expectedFiles = expectedPhysicalFiles(manifest);
  return Object.freeze({
    inventoryDigest: manifest.inventoryDigest,
    expectedFiles,
    expectedFileSetDigest: digestWorkflowTestFileSet(expectedFiles),
  });
}

export function assignWorkflowTestUnitsToShards(
  units: readonly WorkflowTestExecutionUnit[],
): readonly WorkflowTestShard[] {
  const ordered = units.map((unit) => ({
    unit,
    durationMicros: durationToMicros(unit.estimatedDurationMs, unit.entrypoint),
  }));
  ordered.sort(
    (left, right) =>
      right.durationMicros - left.durationMicros ||
      left.unit.legacyOrdinal - right.unit.legacyOrdinal ||
      compareText(left.unit.entrypoint, right.unit.entrypoint),
  );
  const placements = Array.from(
    { length: WORKFLOW_TEST_SHARD_COUNT },
    (_, index) => ({
      shardNumber: index + 1,
      durationMicros: 0,
      units: [] as WorkflowTestExecutionUnit[],
    }),
  );
  for (const weighted of ordered) {
    placements.sort(
      (left, right) =>
        left.durationMicros - right.durationMicros ||
        left.shardNumber - right.shardNumber,
    );
    const selected = placements[0]!;
    selected.durationMicros += weighted.durationMicros;
    selected.units.push(weighted.unit);
  }
  placements.sort((left, right) => left.shardNumber - right.shardNumber);
  return placements.map((placement) => {
    const id = `shard-${String(placement.shardNumber).padStart(2, '0')}`;
    return {
      shardNumber: placement.shardNumber,
      id,
      wrapper: `${TEST_ROOT}/shards/${id}.ts`,
      estimatedDurationMs: microsToDuration(placement.durationMicros),
      units: placement.units.sort(
        (left, right) =>
          left.legacyOrdinal - right.legacyOrdinal ||
          compareText(left.entrypoint, right.entrypoint),
      ),
    };
  });
}

export function assertWorkflowTestShardWrappers(
  repositoryRoot: string,
  manifest: WorkflowTestShardManifest,
): void {
  const root = canonicalRepositoryRoot(repositoryRoot);
  for (const shard of manifest.shards) {
    const wrapperPath = path.join(root, shard.wrapper);
    const observedWrapper = fs.existsSync(wrapperPath)
      ? fs.readFileSync(wrapperPath, 'utf8')
      : '';
    const expectedWrapper = projectWorkflowTestShardWrapper(shard);
    if (observedWrapper !== expectedWrapper) {
      throw new Error(`Workflow test wrapper drifted: ${shard.wrapper}.`);
    }
  }
}

export function digestWorkflowTestFileSet(
  files: readonly string[],
): `sha256:${string}` {
  const seen = new Set<string>();
  for (const file of files) {
    assertWorkflowTestPath(file);
    if (seen.has(file)) {
      throw new Error(`Duplicate workflow test file: ${file}.`);
    }
    seen.add(file);
  }
  return sha256(canonicalJson([...seen].sort(compareText)));
}

export function digestWorkflowTestManifest(
  manifest:
    | Omit<WorkflowTestShardManifest, 'inventoryDigest'>
    | WorkflowTestShardManifest,
): `sha256:${string}` {
  const { inventoryDigest: _inventoryDigest, ...payload } =
    manifest as WorkflowTestShardManifest;
  return sha256(canonicalJson(payload));
}

export function discoverWorkflowTestTopology(
  repositoryRoot: string,
): WorkflowTestTopology {
  const root = canonicalRepositoryRoot(repositoryRoot);
  const testRoot = path.join(root, TEST_ROOT);
  const physicalFiles = listPhysicalTestFiles(root, testRoot);
  const sources: Record<string, string> = {};
  for (const file of physicalFiles) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    sources[file] = source;
    assertWorkflowTestScratchSafety(file, source);
  }

  for (const rootPath of ROOTS) {
    const source = sources[rootPath];
    if (source === undefined) {
      throw new Error(`Workflow test root is missing: ${rootPath}.`);
    }
    if (parseTestImports(rootPath, source).length > 0) {
      throw new Error(
        `Workflow test root ${rootPath} must not statically import its legacy family.`,
      );
    }
    const loader = FAMILY_LOADERS[rootPath]!;
    const expectedDynamicImport = `await import('./${path.posix.basename(loader)}')`;
    if (
      !source.includes('if (import.meta.main)') ||
      !source.includes(expectedDynamicImport)
    ) {
      throw new Error(
        `Workflow test root ${rootPath} does not gate its legacy family on import.meta.main.`,
      );
    }
    const ownCount = countRootTestRegistrations(source);
    if (ownCount !== ROOT_OWN_TEST_COUNTS[rootPath]) {
      throw new Error(
        `Workflow test root ${rootPath} must retain ${ROOT_OWN_TEST_COUNTS[rootPath]} own tests; observed ${ownCount}.`,
      );
    }
  }

  const graph = new Map<string, readonly string[]>();
  for (const file of physicalFiles) {
    graph.set(file, parseTestImports(file, sources[file]!));
  }
  for (const rootPath of ROOTS) {
    const loaderPath = FAMILY_LOADERS[rootPath]!;
    const loaderSource = fs.readFileSync(path.join(root, loaderPath), 'utf8');
    assertStaticImportModule(loaderPath, loaderSource);
    graph.set(rootPath, parseTestImports(loaderPath, loaderSource));
  }

  workflowTestImportClosures(sources, graph);
  const incoming = new Map<string, string>();
  for (const [owner, imports] of graph) {
    for (const imported of imports) {
      if (!sources[imported]) {
        throw new Error(
          `Workflow test ${owner} imports unknown physical test ${imported}.`,
        );
      }
      const prior = incoming.get(imported);
      if (prior !== undefined) {
        throw new Error(
          `Workflow test ${imported} has duplicate import owners ${prior} and ${owner}.`,
        );
      }
      incoming.set(imported, owner);
    }
  }
  for (const rootPath of ROOTS) {
    if (incoming.has(rootPath)) {
      throw new Error(`Workflow test root ${rootPath} cannot be imported.`);
    }
  }
  const unowned = physicalFiles.filter(
    (file) =>
      !ROOTS.includes(file as (typeof ROOTS)[number]) && !incoming.has(file),
  );
  if (unowned.length > 0) {
    throw new Error(
      `Physical workflow tests are absent from the legacy families: ${unowned.join(', ')}.`,
    );
  }

  const units: Array<{
    entrypoint: string;
    ownedPhysicalFiles: readonly string[];
  }> = ROOTS.map((entrypoint) => ({
    entrypoint,
    ownedPhysicalFiles: Object.freeze([entrypoint]),
  }));
  for (const rootPath of ROOTS) {
    for (const entrypoint of graph.get(rootPath) ?? []) {
      units.push({
        entrypoint,
        ownedPhysicalFiles: Object.freeze(
          collectClosure(entrypoint, graph).sort(compareText),
        ),
      });
    }
  }
  const owned = units.flatMap((unit) => unit.ownedPhysicalFiles);
  digestWorkflowTestFileSet(owned);
  if (owned.length !== physicalFiles.length) {
    throw new Error(
      'Workflow test execution units do not own the exact inventory.',
    );
  }
  return deepFreeze({
    physicalFiles: Object.freeze(physicalFiles),
    units: Object.freeze(units),
  });
}

export function workflowTestImportClosures(
  sources: Readonly<Record<string, string>>,
  providedGraph?: ReadonlyMap<string, readonly string[]>,
): ReadonlyMap<string, readonly string[]> {
  const graph =
    providedGraph ??
    new Map(
      Object.entries(sources).map(([file, source]) => [
        file,
        parseTestImports(file, source),
      ]),
    );
  const state = new Map<string, 'visiting' | 'visited'>();
  const closures = new Map<string, readonly string[]>();
  const visit = (file: string, stack: readonly string[]): readonly string[] => {
    if (!(file in sources)) {
      throw new Error(`Workflow test import is unknown: ${file}.`);
    }
    if (state.get(file) === 'visiting') {
      throw new Error(
        `Workflow test import cycle: ${[...stack, file].join(' -> ')}.`,
      );
    }
    const cached = closures.get(file);
    if (cached !== undefined) return cached;
    state.set(file, 'visiting');
    const closure = new Set<string>([file]);
    for (const child of graph.get(file) ?? []) {
      for (const nested of visit(child, [...stack, file])) closure.add(nested);
    }
    state.set(file, 'visited');
    const result = Object.freeze([...closure].sort(compareText));
    closures.set(file, result);
    return result;
  };
  for (const file of Object.keys(sources).sort(compareText)) visit(file, []);
  return closures;
}

export function assertWorkflowTestScratchSafety(
  file: string,
  source: string,
): void {
  if (WORKFLOW_TEST_SCRATCH_SAFETY_EXCEPTIONS.includes(file)) return;
  const unsafe = [
    /mkdtempSync\s*\(\s*path\.(?:join|resolve)\s*\(\s*process\.cwd\s*\(\s*\)/s,
    /mkdtempSync\s*\(\s*process\.cwd\s*\(\s*\)/s,
    /mkdtempSync\s*\(\s*path\.(?:join|resolve)\s*\(\s*(?:sourceRepositoryRoot|sourceRepository)\b/s,
    /mkdtempSync\s*\(\s*path\.(?:join|resolve)\s*\(\s*import\.meta\.(?:dirname|filename)\b/s,
    /mkdtempSync\s*\(\s*['"](?:\.\/|\.\.\/)/s,
  ].some((pattern) => pattern.test(source));
  if (unsafe) {
    throw new Error(
      `Workflow test ${file} creates checkout-relative scratch storage; use the operating-system temporary directory.`,
    );
  }
}

export function projectWorkflowTestShardWrapper(
  shard: WorkflowTestShard,
): string {
  const imports = shard.units.map((unit) => {
    let relative = path.posix.relative(
      path.posix.dirname(shard.wrapper),
      unit.entrypoint,
    );
    if (!relative.startsWith('.')) relative = `./${relative}`;
    return `import '${relative}';`;
  });
  return [
    '/**',
    ' * Generated by scripts/generate-workflow-test-shards.ts.',
    ' * Do not edit by hand; the tracked manifest owns this static import list.',
    ' */',
    ...imports,
    '',
  ].join('\n');
}

function parseManifest(candidate: unknown): WorkflowTestShardManifest {
  if (!isRecord(candidate)) {
    throw new Error('Workflow test shard manifest must be an object.');
  }
  if (
    candidate.schemaVersion !== 1 ||
    candidate.kind !== WORKFLOW_TEST_SHARD_MANIFEST_KIND ||
    canonicalJson(candidate.algorithm) !==
      canonicalJson(WORKFLOW_TEST_SHARD_ALGORITHM) ||
    typeof candidate.sourceTelemetryRunId !== 'string' ||
    !/^run-[0-9]{17}-[0-9a-f-]{36}$/.test(candidate.sourceTelemetryRunId) ||
    typeof candidate.sourceTelemetryDigest !== 'string' ||
    !SHA256_PATTERN.test(candidate.sourceTelemetryDigest) ||
    !Number.isSafeInteger(candidate.physicalFileCount) ||
    (candidate.physicalFileCount as number) < 1 ||
    !Number.isSafeInteger(candidate.executionUnitCount) ||
    (candidate.executionUnitCount as number) < 1 ||
    typeof candidate.inventoryDigest !== 'string' ||
    !SHA256_PATTERN.test(candidate.inventoryDigest) ||
    !Array.isArray(candidate.shards)
  ) {
    throw new Error('Workflow test shard manifest header is invalid.');
  }
  const shards = candidate.shards.map((value, index) =>
    parseShard(value, index),
  );
  return {
    schemaVersion: 1,
    kind: WORKFLOW_TEST_SHARD_MANIFEST_KIND,
    algorithm: WORKFLOW_TEST_SHARD_ALGORITHM,
    sourceTelemetryRunId: candidate.sourceTelemetryRunId,
    sourceTelemetryDigest:
      candidate.sourceTelemetryDigest as `sha256:${string}`,
    physicalFileCount: candidate.physicalFileCount as number,
    executionUnitCount: candidate.executionUnitCount as number,
    inventoryDigest: candidate.inventoryDigest as `sha256:${string}`,
    shards,
  };
}

function parseShard(candidate: unknown, index: number): WorkflowTestShard {
  if (
    !isRecord(candidate) ||
    !Number.isSafeInteger(candidate.shardNumber) ||
    typeof candidate.id !== 'string' ||
    typeof candidate.wrapper !== 'string' ||
    typeof candidate.estimatedDurationMs !== 'number' ||
    !Array.isArray(candidate.units)
  ) {
    throw new Error(`Workflow test shard ${index + 1} is invalid.`);
  }
  return {
    shardNumber: candidate.shardNumber as number,
    id: candidate.id,
    wrapper: candidate.wrapper,
    estimatedDurationMs: candidate.estimatedDurationMs,
    units: candidate.units.map((unit) => parseUnit(unit, index)),
  };
}

function parseUnit(
  candidate: unknown,
  shardIndex: number,
): WorkflowTestExecutionUnit {
  if (
    !isRecord(candidate) ||
    typeof candidate.entrypoint !== 'string' ||
    !Array.isArray(candidate.ownedPhysicalFiles) ||
    candidate.ownedPhysicalFiles.some((file) => typeof file !== 'string') ||
    !Number.isSafeInteger(candidate.legacyOrdinal) ||
    typeof candidate.estimatedDurationMs !== 'number'
  ) {
    throw new Error(
      `Workflow test unit in shard ${shardIndex + 1} is invalid.`,
    );
  }
  return {
    entrypoint: candidate.entrypoint,
    ownedPhysicalFiles: candidate.ownedPhysicalFiles as string[],
    legacyOrdinal: candidate.legacyOrdinal as number,
    estimatedDurationMs: candidate.estimatedDurationMs,
  };
}

function listPhysicalTestFiles(
  repositoryRoot: string,
  testRoot: string,
): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(
          `Workflow test inventory cannot contain a symlink: ${path.relative(repositoryRoot, absolute)}.`,
        );
      }
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
        files.push(toRepositoryPath(repositoryRoot, absolute));
      }
    }
  };
  visit(testRoot);
  return files.sort(compareText);
}

function parseTestImports(owner: string, source: string): string[] {
  const imports: string[] = [];
  const pattern =
    /(?:^|\n)\s*import\s+(?:type\s+)?(?:[^'"\n]*?\s+from\s+)?(['"])([^'"\r\n]+)\1\s*;?/g;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[2]!;
    if (!specifier.endsWith('.test.ts')) continue;
    if (!specifier.startsWith('.')) {
      throw new Error(
        `Workflow test ${owner} has a non-relative test import: ${specifier}.`,
      );
    }
    const resolved = path.posix.normalize(
      path.posix.join(path.posix.dirname(owner), specifier),
    );
    assertWorkflowTestPath(resolved);
    imports.push(resolved);
  }
  if (new Set(imports).size !== imports.length) {
    throw new Error(`Workflow test ${owner} has duplicate static imports.`);
  }
  return imports;
}

function assertStaticImportModule(file: string, source: string): void {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const remainder = withoutComments.replace(
    /(?:^|\n)\s*import\s+(?:type\s+)?(?:[^'"\n]*?\s+from\s+)?(['"])[^'"\r\n]+\1\s*;?/g,
    '\n',
  );
  if (remainder.trim().length > 0) {
    throw new Error(
      `Workflow test static loader ${file} contains executable statements.`,
    );
  }
}

function collectClosure(
  entrypoint: string,
  graph: ReadonlyMap<string, readonly string[]>,
): string[] {
  const result = new Set<string>();
  const visit = (file: string): void => {
    if (result.has(file)) return;
    result.add(file);
    for (const child of graph.get(file) ?? []) visit(child);
  };
  visit(entrypoint);
  return [...result];
}

function countRootTestRegistrations(source: string): number {
  return [...source.matchAll(/^test\s*\(/gm)].length;
}

function assertWorkflowTestPath(file: string): void {
  if (
    typeof file !== 'string' ||
    file.length === 0 ||
    file !== file.normalize('NFC') ||
    file.includes('\\') ||
    file.includes('\0') ||
    file.includes('\r') ||
    file.includes('\n') ||
    path.posix.isAbsolute(file) ||
    path.posix.normalize(file) !== file ||
    !file.startsWith(`${TEST_ROOT}/`) ||
    !file.endsWith('.test.ts')
  ) {
    throw new Error(
      `Workflow test file is not a canonical repository-relative path: ${String(file)}.`,
    );
  }
}

function durationToMicros(durationMs: number, owner: string): number {
  if (
    !Number.isFinite(durationMs) ||
    durationMs < 0 ||
    Math.round(durationMs * 1_000) / 1_000 !== durationMs
  ) {
    throw new Error(`Workflow test duration is invalid for ${owner}.`);
  }
  return Math.round(durationMs * 1_000);
}

function microsToDuration(micros: number): number {
  return micros / 1_000;
}

function canonicalRepositoryRoot(repositoryRoot: string): string {
  if (!path.isAbsolute(repositoryRoot)) {
    throw new Error('Workflow test repository root must be absolute.');
  }
  return fs.realpathSync(repositoryRoot);
}

function toRepositoryPath(repositoryRoot: string, absolute: string): string {
  return path.relative(repositoryRoot, absolute).split(path.sep).join('/');
}

function compareStringArrays(
  left: readonly string[],
  right: readonly string[],
): number {
  return canonicalJson(left).localeCompare(canonicalJson(right), 'en');
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError('Value is not JSON data.');
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort(compareText)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function sha256(value: string | Buffer): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
