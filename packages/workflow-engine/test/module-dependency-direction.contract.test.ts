import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

import { scanT3BoundarySource } from './support/t3-boundary-scanner.ts';

const EXPECTED_MAP_ROWS = 280;
const EXPECTED_FROZEN_MAP_DIGEST =
  'sha256:8ef62fbb0658d245e4fe068659709538ae3e3ac6757cbb8e5e69672f02beafc7';
const EXPECTED_FROZEN_EDGE_COUNT = 775;
const EXPECTED_ACTIVE_EDGE_COUNT = 770;
const EXPECTED_FROZEN_IDENTITY_DIGEST =
  'sha256:4cac2c455369247bd867740f545332841a4784f8f006b4907dd1fcff274e18a5';
const EXPECTED_T3_BOUNDARY_INVENTORY_DIGEST =
  'sha256:b730be789ad0b6302d59d25db071a0804baba1fe5d31471162792c92824cb09e';
const SRC_PREFIX = 'packages/workflow-engine/src/';
const BOOTSTRAP_PREFIX = 'packages/workflow-engine/bootstrap/';
const MAP_FILE = 'workflow-engine-module-map.tsv';
const BASELINE_FILE = 'module-dependency-baseline.json';
const T3_BOUNDARY_INVENTORY_FILE = 't3-boundary-inventory.json';
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
const EXPECTED_T3_COUPLING_IDS = Object.freeze([
  'agent-provider-identity',
  'availability-pilot',
  'central-grant-shadow-authority',
  'collaboration-grant',
  'data-egress-authorization',
  'execution-substrate',
  'openspec-direct-dependency',
  'package-topology',
  'planning-provider-binding',
  'policy-path-literals',
  'provider-plane-separation',
  'provider-runner',
  'recovery-mirror',
  'role-assurance',
  'runtime-distribution',
  'schema-signature-namespace',
]);
const KNOWN_T3_COUPLING_STATES = new Set([
  'coupled',
  'landed',
  'missing',
  'partial',
  'unresolved',
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

type T3BoundaryEvidence = {
  path: string;
  contains: string[];
};

type T3StaticLiteralFinding = {
  path: string;
  start: number;
  length: number;
  normalizedValue: string;
  syntaxForm:
    | 'exact-string'
    | 'embedded-string'
    | 'template-static'
    | 'folded'
    | 'path-join'
    | 'path-resolve'
    | 'fs-readdir'
    | 'fs-readdir-sync'
    | 'namespace-fragment';
};

type T3BoundarySourceFindings = {
  workflowPaths: T3StaticLiteralFinding[];
  splitWorkflowPaths: T3StaticLiteralFinding[];
  dynamicWorkflowDirectories: T3StaticLiteralFinding[];
  namespace: T3StaticLiteralFinding[];
};

type T3NegativeEvidence = {
  absentPaths: string[];
  absentSymbols: string[];
  searchRoots: string[];
};

type T3JsonStringFinding = {
  path: string;
  jsonPointer: string;
  normalizedValue: string;
};

type T3BoundaryCoupling = {
  id: string;
  plane: string;
  state: string;
  t3Disposition: string;
  evidence: T3BoundaryEvidence[];
  negativeEvidence: T3NegativeEvidence | null;
};

type T3BoundaryInventory = {
  kind: 'jigwright.workflow.t3-boundary-inventory.v1';
  schemaVersion: 1;
  observedAtCommit: string;
  architectureDocument: string;
  namespaceBaseline: {
    legacyPrefix: 'expense-app.workflow.';
    sourceOccurrences: number;
    sourceFileCount: number;
    sourceIdentityDigest: string;
    bootstrapOccurrences: number;
    bootstrapFileCount: number;
    bootstrapIdentityDigest: string;
    recoveryOccurrences: number;
    recoveryFileCount: number;
    recoveryIdentityDigest: string;
    workflowJsonOccurrences: number;
    workflowJsonFileCount: number;
    workflowJsonIdentityDigest: string;
    jsonSchemaIdHosts: Record<string, number>;
    jsonSchemaIdIdentityDigest: string;
  };
  workflowJsonReferenceBaseline: {
    sourceOccurrences: number;
    sourceFileCount: number;
    sourceIdentityDigest: string;
    bootstrapOccurrences: number;
    bootstrapFileCount: number;
    bootstrapIdentityDigest: string;
    scriptsOccurrences: number;
    scriptsFileCount: number;
    scriptsIdentityDigest: string;
    recoveryOccurrences: number;
    recoveryFileCount: number;
    recoveryIdentityDigest: string;
    recoverySplitPathJoinOccurrences: number;
    recoverySplitPathJoinFileCount: number;
    recoverySplitPathJoinIdentityDigest: string;
    uniqueLiterals: string[];
    splitPathJoinOccurrences: number;
    splitPathJoinFileCount: number;
    splitPathJoinIdentityDigest: string;
    dynamicDirectoryOccurrences: number;
    dynamicDirectoryFileCount: number;
    dynamicDirectoryIdentityDigest: string;
  };
  workflowArtifactPathBaseline: {
    packagePrefix: 'packages/workflow-engine';
    occurrences: number;
    fileCount: number;
    identityDigest: string;
  };
  couplings: T3BoundaryCoupling[];
};

const repositoryRoot = resolveRepositoryRoot(
  process.env.WORKFLOW_ENGINE_REPOSITORY_ROOT,
);
const repositoryRequire = createRequire(
  path.join(repositoryRoot, 'package.json'),
);
const ts = repositoryRequire('typescript') as typeof import('typescript');
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
    EXPECTED_ACTIVE_EDGE_COUNT,
  );
});

test('T3 boundary coupling inventory is tracked beside the frozen module map', () => {
  const inventoryPath = resolveAssetPath(
    process.env.WORKFLOW_ENGINE_T3_BOUNDARY_INVENTORY,
    T3_BOUNDARY_INVENTORY_FILE,
  );
  const inventorySource = fs.readFileSync(inventoryPath, 'utf8');
  assert.equal(
    digestText(inventorySource),
    EXPECTED_T3_BOUNDARY_INVENTORY_DIGEST,
  );
  const inventory = parseT3BoundaryInventory(inventorySource);
  assert.deepEqual(
    inventory.couplings.map((coupling) => coupling.id),
    EXPECTED_T3_COUPLING_IDS,
  );

  const sourceLiterals = scanTypeScriptBoundaryLiterals(
    repositoryRoot,
    'packages/workflow-engine/src',
    '.ts',
  );
  assert.deepEqual(
    {
      occurrences: sourceLiterals.namespace.length,
      fileCount: new Set(sourceLiterals.namespace.map((entry) => entry.path))
        .size,
      identityDigest: digestStaticFindings(sourceLiterals.namespace),
    },
    {
      occurrences: inventory.namespaceBaseline.sourceOccurrences,
      fileCount: inventory.namespaceBaseline.sourceFileCount,
      identityDigest: inventory.namespaceBaseline.sourceIdentityDigest,
    },
  );

  const scriptLiterals = scanTypeScriptBoundaryLiterals(
    repositoryRoot,
    'scripts',
    '.ts',
  );
  assert.deepEqual(
    {
      occurrences: scriptLiterals.workflowPaths.length,
      fileCount: new Set(
        scriptLiterals.workflowPaths.map((entry) => entry.path),
      ).size,
      identityDigest: digestStaticFindings(scriptLiterals.workflowPaths),
    },
    {
      occurrences: inventory.workflowJsonReferenceBaseline.scriptsOccurrences,
      fileCount: inventory.workflowJsonReferenceBaseline.scriptsFileCount,
      identityDigest:
        inventory.workflowJsonReferenceBaseline.scriptsIdentityDigest,
    },
  );
  assert.equal(
    scriptLiterals.namespace.length,
    0,
    'root scripts must not add a legacy workflow namespace',
  );
  assert.equal(
    scriptLiterals.splitWorkflowPaths.length,
    0,
    'root scripts must not add split workflow JSON paths',
  );
  assert.equal(
    scriptLiterals.dynamicWorkflowDirectories.length,
    0,
    'root scripts must not enumerate the workflow root dynamically',
  );

  const bootstrapLiterals = scanTypeScriptBoundaryLiterals(
    repositoryRoot,
    'packages/workflow-engine/bootstrap',
    '.ts',
  );
  assert.deepEqual(
    {
      occurrences: bootstrapLiterals.namespace.length,
      fileCount: new Set(bootstrapLiterals.namespace.map((entry) => entry.path))
        .size,
      identityDigest: digestStaticFindings(bootstrapLiterals.namespace),
    },
    {
      occurrences: inventory.namespaceBaseline.bootstrapOccurrences,
      fileCount: inventory.namespaceBaseline.bootstrapFileCount,
      identityDigest: inventory.namespaceBaseline.bootstrapIdentityDigest,
    },
  );

  const recoveryLiterals = scanTypeScriptBoundaryLiterals(
    repositoryRoot,
    'packages/workflow-engine/bootstrap/recovery-runtime/src',
    '.js',
  );
  assert.deepEqual(
    {
      occurrences: recoveryLiterals.namespace.length,
      fileCount: new Set(recoveryLiterals.namespace.map((entry) => entry.path))
        .size,
      identityDigest: digestStaticFindings(recoveryLiterals.namespace),
    },
    {
      occurrences: inventory.namespaceBaseline.recoveryOccurrences,
      fileCount: inventory.namespaceBaseline.recoveryFileCount,
      identityDigest: inventory.namespaceBaseline.recoveryIdentityDigest,
    },
  );
  assert.deepEqual(
    {
      occurrences: recoveryLiterals.workflowPaths.length,
      fileCount: new Set(
        recoveryLiterals.workflowPaths.map((entry) => entry.path),
      ).size,
      identityDigest: digestStaticFindings(recoveryLiterals.workflowPaths),
    },
    {
      occurrences: inventory.workflowJsonReferenceBaseline.recoveryOccurrences,
      fileCount: inventory.workflowJsonReferenceBaseline.recoveryFileCount,
      identityDigest:
        inventory.workflowJsonReferenceBaseline.recoveryIdentityDigest,
    },
  );
  assert.deepEqual(
    {
      occurrences: recoveryLiterals.splitWorkflowPaths.length,
      fileCount: new Set(
        recoveryLiterals.splitWorkflowPaths.map((entry) => entry.path),
      ).size,
      identityDigest: digestStaticFindings(recoveryLiterals.splitWorkflowPaths),
    },
    {
      occurrences:
        inventory.workflowJsonReferenceBaseline
          .recoverySplitPathJoinOccurrences,
      fileCount:
        inventory.workflowJsonReferenceBaseline.recoverySplitPathJoinFileCount,
      identityDigest:
        inventory.workflowJsonReferenceBaseline
          .recoverySplitPathJoinIdentityDigest,
    },
  );
  assert.equal(
    recoveryLiterals.dynamicWorkflowDirectories.length,
    0,
    'generated recovery runtime must not enumerate the workflow root dynamically',
  );

  const workflowJsonNamespaces = scanWorkflowJsonNamespaces(repositoryRoot);
  assert.deepEqual(summarizeJsonFindings(workflowJsonNamespaces), {
    occurrences: inventory.namespaceBaseline.workflowJsonOccurrences,
    fileCount: inventory.namespaceBaseline.workflowJsonFileCount,
    identityDigest: inventory.namespaceBaseline.workflowJsonIdentityDigest,
  });
  const jsonSchemaIds = scanJsonSchemaIds(repositoryRoot);
  assert.deepEqual(
    {
      hosts: summarizeJsonSchemaIdHosts(jsonSchemaIds),
      identityDigest: digestJsonFindings(jsonSchemaIds),
    },
    {
      hosts: inventory.namespaceBaseline.jsonSchemaIdHosts,
      identityDigest: inventory.namespaceBaseline.jsonSchemaIdIdentityDigest,
    },
  );

  assert.deepEqual(
    {
      occurrences: sourceLiterals.workflowPaths.length,
      fileCount: new Set(
        sourceLiterals.workflowPaths.map((entry) => entry.path),
      ).size,
      identityDigest: digestStaticFindings(sourceLiterals.workflowPaths),
      uniqueLiterals: [
        ...new Set(
          sourceLiterals.workflowPaths.map((entry) => entry.normalizedValue),
        ),
      ].sort(compareText),
    },
    {
      occurrences: inventory.workflowJsonReferenceBaseline.sourceOccurrences,
      fileCount: inventory.workflowJsonReferenceBaseline.sourceFileCount,
      identityDigest:
        inventory.workflowJsonReferenceBaseline.sourceIdentityDigest,
      uniqueLiterals: inventory.workflowJsonReferenceBaseline.uniqueLiterals,
    },
  );

  assert.deepEqual(
    {
      occurrences: bootstrapLiterals.workflowPaths.length,
      fileCount: new Set(
        bootstrapLiterals.workflowPaths.map((entry) => entry.path),
      ).size,
      identityDigest: digestStaticFindings(bootstrapLiterals.workflowPaths),
    },
    {
      occurrences: inventory.workflowJsonReferenceBaseline.bootstrapOccurrences,
      fileCount: inventory.workflowJsonReferenceBaseline.bootstrapFileCount,
      identityDigest:
        inventory.workflowJsonReferenceBaseline.bootstrapIdentityDigest,
    },
  );
  assert.equal(
    bootstrapLiterals.splitWorkflowPaths.length,
    0,
    'bootstrap TypeScript must not add split workflow JSON paths',
  );
  assert.equal(
    bootstrapLiterals.dynamicWorkflowDirectories.length,
    0,
    'bootstrap TypeScript must not enumerate the workflow root dynamically',
  );

  assert.deepEqual(
    {
      occurrences: sourceLiterals.splitWorkflowPaths.length,
      fileCount: new Set(
        sourceLiterals.splitWorkflowPaths.map((entry) => entry.path),
      ).size,
      identityDigest: digestStaticFindings(sourceLiterals.splitWorkflowPaths),
    },
    {
      occurrences:
        inventory.workflowJsonReferenceBaseline.splitPathJoinOccurrences,
      fileCount: inventory.workflowJsonReferenceBaseline.splitPathJoinFileCount,
      identityDigest:
        inventory.workflowJsonReferenceBaseline.splitPathJoinIdentityDigest,
    },
  );

  const workflowArtifactPaths = scanWorkflowArtifactPaths(repositoryRoot);
  assert.deepEqual(summarizeJsonFindings(workflowArtifactPaths), {
    occurrences: inventory.workflowArtifactPathBaseline.occurrences,
    fileCount: inventory.workflowArtifactPathBaseline.fileCount,
    identityDigest: inventory.workflowArtifactPathBaseline.identityDigest,
  });
  assert.deepEqual(
    {
      occurrences: sourceLiterals.dynamicWorkflowDirectories.length,
      fileCount: new Set(
        sourceLiterals.dynamicWorkflowDirectories.map((entry) => entry.path),
      ).size,
      identityDigest: digestStaticFindings(
        sourceLiterals.dynamicWorkflowDirectories,
      ),
    },
    {
      occurrences:
        inventory.workflowJsonReferenceBaseline.dynamicDirectoryOccurrences,
      fileCount:
        inventory.workflowJsonReferenceBaseline.dynamicDirectoryFileCount,
      identityDigest:
        inventory.workflowJsonReferenceBaseline.dynamicDirectoryIdentityDigest,
    },
  );

  for (const coupling of inventory.couplings) {
    for (const evidence of coupling.evidence) {
      assertBoundaryEvidence(repositoryRoot, coupling.id, evidence);
    }
    if (coupling.state === 'missing') {
      assert.ok(
        coupling.negativeEvidence,
        `${coupling.id} needs two-method negative evidence`,
      );
    }
    if (coupling.negativeEvidence !== null) {
      assert.ok(
        coupling.state === 'missing' || coupling.state === 'partial',
        `${coupling.id} negative evidence is only valid for a missing or partial surface`,
      );
      assertNegativeEvidence(
        repositoryRoot,
        coupling.id,
        coupling.negativeEvidence,
      );
    }
  }

  const architectureDocument = path.join(
    repositoryRoot,
    inventory.architectureDocument,
  );
  const architectureSource = fs.readFileSync(architectureDocument, 'utf8');
  for (const couplingId of EXPECTED_T3_COUPLING_IDS) {
    assert.match(
      architectureSource,
      new RegExp(`<!-- coupling:${escapeRegex(couplingId)} -->`, 'u'),
    );
  }
});

test('T3 scanner finds syntax-bound direct, split, and dynamic workflow paths', () => {
  const source = [
    "import nodePath from 'node:path';",
    "import { readdirSync as listDirectory } from 'node:fs';",
    "const exact = 'workflow/exact.json';",
    "const embedded = 'HEAD:workflow/embedded.json';",
    'const suffix = getSuffix();',
    'const template = `prefix:workflow/template.json:${suffix}`;',
    "const folded = 'workflow/' + 'folded.json';",
    "const sentence = 'Unable to read workflow/sentence.json.';",
    "const workflowRoot = nodePath.join(repositoryRoot, 'workflow');",
    "const joined = nodePath.join(workflowRoot, 'joined.json');",
    "const sameCall = nodePath.resolve(repositoryRoot, 'workflow', 'same.json');",
    'const entries = listDirectory(workflowRoot);',
    "const nearPrefix = 'myworkflow/not-a-match.json';",
    "const nearSuffix = 'workflow/not-a-match.json.bak';",
    "const nested = 'workflow/nested/not-a-match.json';",
    "// nodePath.join(repositoryRoot, 'workflow', 'comment.json');",
    "// listDirectory(nodePath.join(repositoryRoot, 'workflow'));",
  ].join('\n');

  const findings = scanT3BoundarySource(
    ts,
    'synthetic/t3-scanner.ts',
    source,
    '.ts',
  );

  assert.deepEqual(
    findings.workflowPaths.map((finding) => finding.normalizedValue).sort(),
    [
      'workflow/embedded.json',
      'workflow/exact.json',
      'workflow/folded.json',
      'workflow/sentence.json',
      'workflow/template.json',
    ],
  );
  assert.deepEqual(
    findings.splitWorkflowPaths
      .map((finding) => finding.normalizedValue)
      .sort(),
    ['workflow/joined.json', 'workflow/same.json'],
  );
  assert.deepEqual(
    findings.dynamicWorkflowDirectories.map(
      (finding) => finding.normalizedValue,
    ),
    ['workflow/'],
  );

  const sameCountReplacement = scanT3BoundarySource(
    ts,
    'synthetic/t3-scanner.ts',
    source.replace('workflow/exact.json', 'workflow/other.json'),
    '.ts',
  );
  assert.equal(
    sameCountReplacement.workflowPaths.length,
    findings.workflowPaths.length,
  );
  assert.notEqual(
    digestStaticFindings(sameCountReplacement.workflowPaths),
    digestStaticFindings(findings.workflowPaths),
  );
});

test('T3 scanner follows imported aliases and rejects shadowed lookalikes', () => {
  const first = scanT3BoundarySource(
    ts,
    'synthetic/alias.ts',
    [
      "import nodePath from 'node:path';",
      "import nodeFs from 'node:fs';",
      "const workflowRoot = nodePath.join(input.repositoryRoot, 'workflow');",
      "const policy = nodePath.join(workflowRoot, 'config.json');",
      'const entries = nodeFs.readdirSync(workflowRoot);',
    ].join('\n'),
    '.ts',
  );
  const renamed = scanT3BoundarySource(
    ts,
    'synthetic/alias.ts',
    [
      "import p from 'node:path';",
      "import fsApi from 'node:fs';",
      "const root = p.join(input.repositoryRoot, 'workflow');",
      "const policy = p.join(root, 'config.json');",
      'const entries = fsApi.readdirSync(root);',
    ].join('\n'),
    '.ts',
  );
  assert.equal(
    digestStaticFindings(first.splitWorkflowPaths),
    digestStaticFindings(renamed.splitWorkflowPaths),
  );
  assert.equal(
    digestStaticFindings(first.dynamicWorkflowDirectories),
    digestStaticFindings(renamed.dynamicWorkflowDirectories),
  );

  const shadowed = scanT3BoundarySource(
    ts,
    'synthetic/shadowed.ts',
    [
      "import p from 'node:path';",
      'function run(p: FakePath) {',
      "  return p.join(repositoryRoot, 'workflow', 'fake.json');",
      '}',
    ].join('\n'),
    '.ts',
  );
  assert.equal(shadowed.splitWorkflowPaths.length, 0);

  const destructuredShadow = scanT3BoundarySource(
    ts,
    'synthetic/destructured-shadow.ts',
    [
      "import p from 'node:path';",
      'function run() {',
      '  const { p } = fakePathApi;',
      "  return p.join(repositoryRoot, 'workflow', 'fake.json');",
      '}',
    ].join('\n'),
    '.ts',
  );
  assert.equal(destructuredShadow.splitWorkflowPaths.length, 0);

  const functionScopedVar = scanT3BoundarySource(
    ts,
    'synthetic/var-shadow.ts',
    [
      "import p from 'node:path';",
      'function run() {',
      '  if (condition) { var p = fakePathApi; }',
      "  return p.join(repositoryRoot, 'workflow', 'fake.json');",
      '}',
    ].join('\n'),
    '.ts',
  );
  assert.equal(functionScopedVar.splitWorkflowPaths.length, 0);

  const fakeRepositoryRoot = scanT3BoundarySource(
    ts,
    'synthetic/fake-root.ts',
    [
      "import p from 'node:path';",
      "const repositoryRoot = '/tmp/not-the-repository';",
      "const policy = p.join(repositoryRoot, 'workflow', 'fake.json');",
    ].join('\n'),
    '.ts',
  );
  assert.equal(fakeRepositoryRoot.splitWorkflowPaths.length, 0);

  const inlineDynamic = scanT3BoundarySource(
    ts,
    'synthetic/inline.ts',
    [
      "import p from 'node:path';",
      "import fsApi from 'node:fs';",
      "const entries = fsApi.promises.readdir(p.resolve(repositoryRoot, 'workflow'));",
    ].join('\n'),
    '.ts',
  );
  assert.deepEqual(
    inlineDynamic.dynamicWorkflowDirectories.map(
      (finding) => finding.syntaxForm,
    ),
    ['fs-readdir'],
  );

  const promisesImport = scanT3BoundarySource(
    ts,
    'synthetic/promises.ts',
    [
      "import p from 'node:path';",
      "import fsPromises from 'node:fs/promises';",
      "const entries = fsPromises.readdir(p.join(repositoryRoot, 'workflow'));",
    ].join('\n'),
    '.ts',
  );
  assert.equal(promisesImport.dynamicWorkflowDirectories.length, 1);

  const invalidPromisesSync = scanT3BoundarySource(
    ts,
    'synthetic/promises-sync.ts',
    [
      "import p from 'node:path';",
      "import fsPromises from 'node:fs/promises';",
      "const entries = fsPromises.readdirSync(p.join(repositoryRoot, 'workflow'));",
    ].join('\n'),
    '.ts',
  );
  assert.equal(invalidPromisesSync.dynamicWorkflowDirectories.length, 0);

  const propertyAliases = scanT3BoundarySource(
    ts,
    'synthetic/property-aliases.ts',
    [
      "import p from 'node:path';",
      "import fsApi from 'node:fs';",
      'const fsPromises = fsApi.promises;',
      "const entries = fsPromises.readdir(p.posix.join(repositoryRoot, 'workflow'));",
    ].join('\n'),
    '.ts',
  );
  assert.equal(propertyAliases.dynamicWorkflowDirectories.length, 1);

  const namedPropertyImports = scanT3BoundarySource(
    ts,
    'synthetic/named-property-imports.ts',
    [
      "import { posix as pathApi } from 'node:path';",
      "import { promises as fsPromises } from 'node:fs';",
      "const entries = fsPromises.readdir(pathApi.join(repositoryRoot, 'workflow'));",
    ].join('\n'),
    '.ts',
  );
  assert.equal(namedPropertyImports.dynamicWorkflowDirectories.length, 1);

  const destructuredRoot = scanT3BoundarySource(
    ts,
    'synthetic/destructured-root.ts',
    [
      "import p from 'node:path';",
      'const { repositoryRoot } = input;',
      "const policy = p.join(repositoryRoot, 'workflow', 'config.json');",
    ].join('\n'),
    '.ts',
  );
  assert.equal(destructuredRoot.splitWorkflowPaths.length, 1);
});

test('T3 scanner records folded namespaces and dynamic fragments', () => {
  const findings = scanT3BoundarySource(
    ts,
    'synthetic/namespaces.ts',
    [
      "const exact = 'expense-app.workflow.exact.v1';",
      "const folded = 'expense-app.workflow.' + 'folded.v1';",
      "const wrapped = ('expense-app.workflow.' as const) + 'wrapped.v1';",
      "const suffix = 'template.v1';",
      'const staticTemplate = `expense-app.workflow.${suffix}`;',
      'const dynamic = `expense-app.workflow.${kind}`;',
      "// const ignored = 'expense-app.workflow.comment.v1';",
    ].join('\n'),
    '.ts',
  );
  assert.deepEqual(
    findings.namespace.map((finding) => finding.normalizedValue).sort(),
    [
      'expense-app.workflow.',
      'expense-app.workflow.exact.v1',
      'expense-app.workflow.folded.v1',
      'expense-app.workflow.template.v1',
      'expense-app.workflow.wrapped.v1',
    ],
  );
});

test('T3 JSON identity catches same-host replacements and canonicalizes finding order', () => {
  const schemaIds: T3JsonStringFinding[] = [
    {
      path: 'workflow/schemas/first.schema.json',
      jsonPointer: '/$id',
      normalizedValue: 'https://expense-app.local/workflow/first.schema.json',
    },
    {
      path: 'workflow/schemas/second.schema.json',
      jsonPointer: '/$id',
      normalizedValue: 'https://expense-app.local/workflow/second.schema.json',
    },
  ];
  const replacement = schemaIds.map((finding, index) =>
    index === 0
      ? {
          ...finding,
          normalizedValue:
            'http://expense-app.local/workflow/replaced.schema.json',
        }
      : finding,
  );
  assert.deepEqual(
    summarizeJsonSchemaIdHosts(replacement),
    summarizeJsonSchemaIdHosts(schemaIds),
  );
  assert.notEqual(
    digestJsonFindings(replacement),
    digestJsonFindings(schemaIds),
  );
  assert.equal(
    digestJsonFindings([...schemaIds].reverse()),
    digestJsonFindings(schemaIds),
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
  const observed = baseline.edges
    .filter((edge) => edge.status === 'active')
    .map(observedEdge);

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

test('current repository matches the exact active dependency baseline', () => {
  const current = readRepositorySnapshot(repositoryRoot);
  const violations = scanViolations(current, moduleMap, {
    requireFinal: false,
  });
  assert.equal(violations.length, EXPECTED_ACTIVE_EDGE_COUNT);
  assertObservedMatchesBaseline(violations, baseline);
});

test('a new file under a recognized organized root is scanned with self identity', () => {
  const current = withGreenOrganizedSource(
    readRepositorySnapshot(repositoryRoot),
  );
  const violations = scanViolations(current, moduleMap, {
    requireFinal: false,
  });
  assert.equal(violations.length, EXPECTED_ACTIVE_EDGE_COUNT);
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
  const forbiddenSource = `${SRC_PREFIX}modules/source/generated-forbidden-edge.ts`;
  const sessionStoreSpecifier = mappedRelativeSpecifier(
    current,
    forbiddenSource,
    `${SRC_PREFIX}session-store.ts`,
  );
  current.set(
    forbiddenSource,
    [
      `import { runtimePaths } from "${sessionStoreSpecifier}";`,
      'export { runtimePaths };',
      '',
    ].join('\n'),
  );
  const violations = scanViolations(current, moduleMap, {
    requireFinal: false,
  });
  assert.equal(violations.length, EXPECTED_ACTIVE_EDGE_COUNT + 1);
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

function parseT3BoundaryInventory(text: string): T3BoundaryInventory {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error('T3 boundary inventory is malformed JSON.', {
      cause: error,
    });
  }
  assertPlainObject(value, 'T3 boundary inventory');
  assertExactKeys(value, [
    'architectureDocument',
    'workflowArtifactPathBaseline',
    'couplings',
    'kind',
    'namespaceBaseline',
    'observedAtCommit',
    'workflowJsonReferenceBaseline',
    'schemaVersion',
  ]);
  if (
    value.kind !== 'jigwright.workflow.t3-boundary-inventory.v1' ||
    value.schemaVersion !== 1 ||
    typeof value.observedAtCommit !== 'string' ||
    !/^[0-9a-f]{40}$/u.test(value.observedAtCommit) ||
    typeof value.architectureDocument !== 'string' ||
    !isSafeRepositoryRelativePath(value.architectureDocument) ||
    !Array.isArray(value.couplings)
  ) {
    throw new Error('T3 boundary inventory header is invalid.');
  }

  assertPlainObject(value.namespaceBaseline, 'T3 namespace baseline');
  assertExactKeys(value.namespaceBaseline, [
    'bootstrapFileCount',
    'bootstrapIdentityDigest',
    'bootstrapOccurrences',
    'jsonSchemaIdIdentityDigest',
    'jsonSchemaIdHosts',
    'legacyPrefix',
    'recoveryFileCount',
    'recoveryIdentityDigest',
    'recoveryOccurrences',
    'sourceFileCount',
    'sourceIdentityDigest',
    'sourceOccurrences',
    'workflowJsonFileCount',
    'workflowJsonIdentityDigest',
    'workflowJsonOccurrences',
  ]);
  assertPlainObject(
    value.namespaceBaseline.jsonSchemaIdHosts,
    'T3 JSON Schema host baseline',
  );
  if (
    value.namespaceBaseline.legacyPrefix !== 'expense-app.workflow.' ||
    !isNonNegativeInteger(value.namespaceBaseline.sourceOccurrences) ||
    !isNonNegativeInteger(value.namespaceBaseline.sourceFileCount) ||
    !isSha256Digest(value.namespaceBaseline.sourceIdentityDigest) ||
    !isNonNegativeInteger(value.namespaceBaseline.bootstrapOccurrences) ||
    !isNonNegativeInteger(value.namespaceBaseline.bootstrapFileCount) ||
    !isSha256Digest(value.namespaceBaseline.bootstrapIdentityDigest) ||
    !isNonNegativeInteger(value.namespaceBaseline.recoveryOccurrences) ||
    !isNonNegativeInteger(value.namespaceBaseline.recoveryFileCount) ||
    !isSha256Digest(value.namespaceBaseline.recoveryIdentityDigest) ||
    !isNonNegativeInteger(value.namespaceBaseline.workflowJsonOccurrences) ||
    !isNonNegativeInteger(value.namespaceBaseline.workflowJsonFileCount) ||
    !isSha256Digest(value.namespaceBaseline.workflowJsonIdentityDigest) ||
    !isSha256Digest(value.namespaceBaseline.jsonSchemaIdIdentityDigest)
  ) {
    throw new Error('T3 namespace baseline is invalid.');
  }
  const jsonSchemaIdHosts: Record<string, number> = {};
  for (const [host, count] of Object.entries(
    value.namespaceBaseline.jsonSchemaIdHosts,
  )) {
    if (!/^[a-z0-9.-]+$/u.test(host) || !isNonNegativeInteger(count)) {
      throw new Error('T3 JSON Schema host baseline is invalid.');
    }
    jsonSchemaIdHosts[host] = count;
  }

  assertPlainObject(
    value.workflowJsonReferenceBaseline,
    'T3 workflow JSON reference baseline',
  );
  assertExactKeys(value.workflowJsonReferenceBaseline, [
    'bootstrapFileCount',
    'bootstrapIdentityDigest',
    'bootstrapOccurrences',
    'dynamicDirectoryFileCount',
    'dynamicDirectoryIdentityDigest',
    'dynamicDirectoryOccurrences',
    'recoveryFileCount',
    'recoveryIdentityDigest',
    'recoveryOccurrences',
    'recoverySplitPathJoinFileCount',
    'recoverySplitPathJoinIdentityDigest',
    'recoverySplitPathJoinOccurrences',
    'scriptsFileCount',
    'scriptsIdentityDigest',
    'scriptsOccurrences',
    'sourceFileCount',
    'sourceIdentityDigest',
    'sourceOccurrences',
    'splitPathJoinFileCount',
    'splitPathJoinIdentityDigest',
    'splitPathJoinOccurrences',
    'uniqueLiterals',
  ]);
  if (
    !isNonNegativeInteger(
      value.workflowJsonReferenceBaseline.sourceOccurrences,
    ) ||
    !isNonNegativeInteger(
      value.workflowJsonReferenceBaseline.sourceFileCount,
    ) ||
    !isSha256Digest(value.workflowJsonReferenceBaseline.sourceIdentityDigest) ||
    !isNonNegativeInteger(
      value.workflowJsonReferenceBaseline.bootstrapOccurrences,
    ) ||
    !isNonNegativeInteger(
      value.workflowJsonReferenceBaseline.bootstrapFileCount,
    ) ||
    !isSha256Digest(
      value.workflowJsonReferenceBaseline.bootstrapIdentityDigest,
    ) ||
    !isNonNegativeInteger(
      value.workflowJsonReferenceBaseline.scriptsOccurrences,
    ) ||
    !isNonNegativeInteger(
      value.workflowJsonReferenceBaseline.scriptsFileCount,
    ) ||
    !isSha256Digest(
      value.workflowJsonReferenceBaseline.scriptsIdentityDigest,
    ) ||
    !isNonNegativeInteger(
      value.workflowJsonReferenceBaseline.recoveryOccurrences,
    ) ||
    !isNonNegativeInteger(
      value.workflowJsonReferenceBaseline.recoveryFileCount,
    ) ||
    !isSha256Digest(
      value.workflowJsonReferenceBaseline.recoveryIdentityDigest,
    ) ||
    !isNonNegativeInteger(
      value.workflowJsonReferenceBaseline.recoverySplitPathJoinOccurrences,
    ) ||
    !isNonNegativeInteger(
      value.workflowJsonReferenceBaseline.recoverySplitPathJoinFileCount,
    ) ||
    !isSha256Digest(
      value.workflowJsonReferenceBaseline.recoverySplitPathJoinIdentityDigest,
    ) ||
    !Array.isArray(value.workflowJsonReferenceBaseline.uniqueLiterals) ||
    !isNonNegativeInteger(
      value.workflowJsonReferenceBaseline.splitPathJoinOccurrences,
    ) ||
    !isNonNegativeInteger(
      value.workflowJsonReferenceBaseline.splitPathJoinFileCount,
    ) ||
    !isSha256Digest(
      value.workflowJsonReferenceBaseline.splitPathJoinIdentityDigest,
    ) ||
    !isNonNegativeInteger(
      value.workflowJsonReferenceBaseline.dynamicDirectoryOccurrences,
    ) ||
    !isNonNegativeInteger(
      value.workflowJsonReferenceBaseline.dynamicDirectoryFileCount,
    ) ||
    !isSha256Digest(
      value.workflowJsonReferenceBaseline.dynamicDirectoryIdentityDigest,
    )
  ) {
    throw new Error('T3 workflow JSON reference baseline is invalid.');
  }
  const uniqueLiterals = value.workflowJsonReferenceBaseline.uniqueLiterals.map(
    (literal) => {
      if (
        typeof literal !== 'string' ||
        !/^workflow\/[A-Za-z0-9][A-Za-z0-9._-]*\.json$/u.test(literal)
      ) {
        throw new Error('T3 policy literal baseline contains an invalid path.');
      }
      return literal;
    },
  );
  assert.deepEqual(
    uniqueLiterals,
    [...new Set(uniqueLiterals)].sort(compareText),
    'T3 policy literals must be sorted and unique.',
  );

  assertPlainObject(
    value.workflowArtifactPathBaseline,
    'T3 workflow artifact path baseline',
  );
  assertExactKeys(value.workflowArtifactPathBaseline, [
    'fileCount',
    'identityDigest',
    'occurrences',
    'packagePrefix',
  ]);
  if (
    value.workflowArtifactPathBaseline.packagePrefix !==
      'packages/workflow-engine' ||
    !isNonNegativeInteger(value.workflowArtifactPathBaseline.occurrences) ||
    !isNonNegativeInteger(value.workflowArtifactPathBaseline.fileCount) ||
    !isSha256Digest(value.workflowArtifactPathBaseline.identityDigest)
  ) {
    throw new Error('T3 workflow artifact path baseline is invalid.');
  }

  const couplings = value.couplings.map((candidate, index) => {
    assertPlainObject(candidate, `T3 coupling ${index + 1}`);
    assertExactKeys(candidate, [
      'evidence',
      'id',
      'negativeEvidence',
      'plane',
      'state',
      't3Disposition',
    ]);
    if (
      typeof candidate.id !== 'string' ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(candidate.id) ||
      typeof candidate.plane !== 'string' ||
      candidate.plane.length === 0 ||
      typeof candidate.state !== 'string' ||
      !KNOWN_T3_COUPLING_STATES.has(candidate.state) ||
      typeof candidate.t3Disposition !== 'string' ||
      candidate.t3Disposition.length === 0 ||
      !Array.isArray(candidate.evidence)
    ) {
      throw new Error(`T3 coupling ${index + 1} is invalid.`);
    }
    const evidence = candidate.evidence.map((entry, evidenceIndex) =>
      parseT3BoundaryEvidence(
        entry,
        `T3 coupling ${candidate.id} evidence ${evidenceIndex + 1}`,
      ),
    );
    let negativeEvidence: T3NegativeEvidence | null = null;
    if (candidate.negativeEvidence !== null) {
      assertPlainObject(
        candidate.negativeEvidence,
        `T3 coupling ${candidate.id} negative evidence`,
      );
      assertExactKeys(candidate.negativeEvidence, [
        'absentPaths',
        'absentSymbols',
        'searchRoots',
      ]);
      const absentPaths = parseStringList(
        candidate.negativeEvidence.absentPaths,
        'absent path',
      );
      const absentSymbols = parseStringList(
        candidate.negativeEvidence.absentSymbols,
        'absent symbol',
      );
      const searchRoots = parseStringList(
        candidate.negativeEvidence.searchRoots,
        'search root',
      );
      if (
        absentPaths.length === 0 ||
        absentSymbols.length === 0 ||
        searchRoots.length === 0 ||
        [...absentPaths, ...searchRoots].some(
          (entry) => !isSafeRepositoryRelativePath(entry),
        )
      ) {
        throw new Error(
          `T3 coupling ${candidate.id} lacks two-method negative evidence.`,
        );
      }
      negativeEvidence = { absentPaths, absentSymbols, searchRoots };
    }
    return {
      id: candidate.id,
      plane: candidate.plane,
      state: candidate.state,
      t3Disposition: candidate.t3Disposition,
      evidence,
      negativeEvidence,
    };
  });
  assert.deepEqual(
    couplings.map((coupling) => coupling.id),
    [...new Set(couplings.map((coupling) => coupling.id))].sort(compareText),
    'T3 coupling IDs must be sorted and unique.',
  );

  return {
    kind: 'jigwright.workflow.t3-boundary-inventory.v1',
    schemaVersion: 1,
    observedAtCommit: value.observedAtCommit,
    architectureDocument: value.architectureDocument,
    namespaceBaseline: {
      legacyPrefix: 'expense-app.workflow.',
      sourceOccurrences: value.namespaceBaseline.sourceOccurrences,
      sourceFileCount: value.namespaceBaseline.sourceFileCount,
      sourceIdentityDigest: value.namespaceBaseline.sourceIdentityDigest,
      bootstrapOccurrences: value.namespaceBaseline.bootstrapOccurrences,
      bootstrapFileCount: value.namespaceBaseline.bootstrapFileCount,
      bootstrapIdentityDigest: value.namespaceBaseline.bootstrapIdentityDigest,
      recoveryOccurrences: value.namespaceBaseline.recoveryOccurrences,
      recoveryFileCount: value.namespaceBaseline.recoveryFileCount,
      recoveryIdentityDigest: value.namespaceBaseline.recoveryIdentityDigest,
      workflowJsonOccurrences: value.namespaceBaseline.workflowJsonOccurrences,
      workflowJsonFileCount: value.namespaceBaseline.workflowJsonFileCount,
      workflowJsonIdentityDigest:
        value.namespaceBaseline.workflowJsonIdentityDigest,
      jsonSchemaIdHosts,
      jsonSchemaIdIdentityDigest:
        value.namespaceBaseline.jsonSchemaIdIdentityDigest,
    },
    workflowJsonReferenceBaseline: {
      sourceOccurrences: value.workflowJsonReferenceBaseline.sourceOccurrences,
      sourceFileCount: value.workflowJsonReferenceBaseline.sourceFileCount,
      sourceIdentityDigest:
        value.workflowJsonReferenceBaseline.sourceIdentityDigest,
      bootstrapOccurrences:
        value.workflowJsonReferenceBaseline.bootstrapOccurrences,
      bootstrapFileCount:
        value.workflowJsonReferenceBaseline.bootstrapFileCount,
      bootstrapIdentityDigest:
        value.workflowJsonReferenceBaseline.bootstrapIdentityDigest,
      scriptsOccurrences:
        value.workflowJsonReferenceBaseline.scriptsOccurrences,
      scriptsFileCount: value.workflowJsonReferenceBaseline.scriptsFileCount,
      scriptsIdentityDigest:
        value.workflowJsonReferenceBaseline.scriptsIdentityDigest,
      recoveryOccurrences:
        value.workflowJsonReferenceBaseline.recoveryOccurrences,
      recoveryFileCount: value.workflowJsonReferenceBaseline.recoveryFileCount,
      recoveryIdentityDigest:
        value.workflowJsonReferenceBaseline.recoveryIdentityDigest,
      recoverySplitPathJoinOccurrences:
        value.workflowJsonReferenceBaseline.recoverySplitPathJoinOccurrences,
      recoverySplitPathJoinFileCount:
        value.workflowJsonReferenceBaseline.recoverySplitPathJoinFileCount,
      recoverySplitPathJoinIdentityDigest:
        value.workflowJsonReferenceBaseline.recoverySplitPathJoinIdentityDigest,
      uniqueLiterals,
      splitPathJoinOccurrences:
        value.workflowJsonReferenceBaseline.splitPathJoinOccurrences,
      splitPathJoinFileCount:
        value.workflowJsonReferenceBaseline.splitPathJoinFileCount,
      splitPathJoinIdentityDigest:
        value.workflowJsonReferenceBaseline.splitPathJoinIdentityDigest,
      dynamicDirectoryOccurrences:
        value.workflowJsonReferenceBaseline.dynamicDirectoryOccurrences,
      dynamicDirectoryFileCount:
        value.workflowJsonReferenceBaseline.dynamicDirectoryFileCount,
      dynamicDirectoryIdentityDigest:
        value.workflowJsonReferenceBaseline.dynamicDirectoryIdentityDigest,
    },
    workflowArtifactPathBaseline: {
      packagePrefix: 'packages/workflow-engine',
      occurrences: value.workflowArtifactPathBaseline.occurrences,
      fileCount: value.workflowArtifactPathBaseline.fileCount,
      identityDigest: value.workflowArtifactPathBaseline.identityDigest,
    },
    couplings,
  };
}

function parseT3BoundaryEvidence(
  value: unknown,
  label: string,
): T3BoundaryEvidence {
  assertPlainObject(value, label);
  assertExactKeys(value, ['contains', 'path']);
  if (
    typeof value.path !== 'string' ||
    !isSafeRepositoryRelativePath(value.path)
  ) {
    throw new Error(`${label} has an invalid path.`);
  }
  const contains = parseStringList(value.contains, `${label} substring`);
  if (contains.length === 0) {
    throw new Error(`${label} must name at least one substring.`);
  }
  return { path: value.path, contains };
}

function parseStringList(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some(
      (entry) =>
        typeof entry !== 'string' || entry.length === 0 || entry.includes('\0'),
    )
  ) {
    throw new Error(`T3 ${label} list is invalid.`);
  }
  return value as string[];
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isSha256Digest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function isSafeRepositoryRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    !path.posix.isAbsolute(value) &&
    !value.includes('\\') &&
    path.posix.normalize(value) === value &&
    value
      .split('/')
      .every((part) => part.length > 0 && part !== '.' && part !== '..')
  );
}

function scanTypeScriptBoundaryLiterals(
  root: string,
  relativeRoot: string,
  extension: string,
): T3BoundarySourceFindings {
  const result: T3BoundarySourceFindings = {
    workflowPaths: [],
    splitWorkflowPaths: [],
    dynamicWorkflowDirectories: [],
    namespace: [],
  };
  for (const file of listRegularFiles(root, relativeRoot)) {
    if (!file.endsWith(extension)) continue;
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const structural = scanT3BoundarySource(ts, file, source, extension);
    result.workflowPaths.push(...structural.workflowPaths);
    result.namespace.push(...structural.namespace);
    result.splitWorkflowPaths.push(...structural.splitWorkflowPaths);
    result.dynamicWorkflowDirectories.push(
      ...structural.dynamicWorkflowDirectories,
    );
  }
  result.workflowPaths.sort(compareStaticFinding);
  result.splitWorkflowPaths.sort(compareStaticFinding);
  result.dynamicWorkflowDirectories.sort(compareStaticFinding);
  result.namespace.sort(compareStaticFinding);
  return result;
}

function compareStaticFinding(
  left: T3StaticLiteralFinding,
  right: T3StaticLiteralFinding,
): number {
  return (
    compareText(left.path, right.path) ||
    left.start - right.start ||
    compareText(left.normalizedValue, right.normalizedValue) ||
    compareText(left.syntaxForm, right.syntaxForm)
  );
}

function digestStaticFindings(
  findings: readonly T3StaticLiteralFinding[],
): string {
  return digestText(
    findings
      .map((finding) =>
        [finding.path, finding.normalizedValue, finding.syntaxForm].join('\0'),
      )
      .sort(compareText)
      .join('\n'),
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function scanWorkflowJsonNamespaces(root: string): T3JsonStringFinding[] {
  const result: T3JsonStringFinding[] = [];
  for (const finding of scanJsonStringLeaves(
    root,
    'workflow',
    (_file, _pointer, value) => value.includes('expense-app.workflow.'),
  )) {
    let matched = false;
    for (const match of finding.normalizedValue.matchAll(
      /expense-app\.workflow\.[A-Za-z0-9._-]+/gu,
    )) {
      matched = true;
      result.push({ ...finding, normalizedValue: match[0] });
    }
    if (!matched) {
      result.push({
        ...finding,
        normalizedValue: 'expense-app.workflow.',
      });
    }
  }
  return result.sort(compareJsonFindings);
}

function scanWorkflowArtifactPaths(root: string): T3JsonStringFinding[] {
  return scanJsonStringLeaves(
    root,
    'workflow',
    (file, _pointer, value) =>
      path.posix.dirname(file) === 'workflow' &&
      (value === 'packages/workflow-engine' ||
        value.startsWith('packages/workflow-engine/')),
  );
}

function scanJsonSchemaIds(root: string): T3JsonStringFinding[] {
  const result: T3JsonStringFinding[] = [];
  for (const file of listRegularFiles(root, 'workflow/schemas')) {
    if (!file.endsWith('.json')) continue;
    const value = JSON.parse(
      fs.readFileSync(path.join(root, file), 'utf8'),
    ) as unknown;
    assertPlainObject(value, `JSON Schema ${file}`);
    if (
      !Object.prototype.hasOwnProperty.call(value, '$id') ||
      typeof value.$id !== 'string'
    ) {
      throw new Error(`JSON Schema ${file} must have a root string $id.`);
    }
    try {
      new URL(value.$id);
    } catch {
      throw new Error(`JSON Schema ${file} has an invalid $id.`);
    }
    result.push({
      path: file,
      jsonPointer: '/$id',
      normalizedValue: value.$id,
    });
  }
  return result.sort(compareJsonFindings);
}

function scanJsonStringLeaves(
  root: string,
  relativeRoot: string,
  include: (file: string, jsonPointer: string, value: string) => boolean,
): T3JsonStringFinding[] {
  const result: T3JsonStringFinding[] = [];
  for (const file of listRegularFiles(root, relativeRoot)) {
    if (!file.endsWith('.json')) continue;
    const value = JSON.parse(
      fs.readFileSync(path.join(root, file), 'utf8'),
    ) as unknown;
    visitJsonStrings(value, '', (jsonPointer, leaf) => {
      if (include(file, jsonPointer, leaf)) {
        result.push({ path: file, jsonPointer, normalizedValue: leaf });
      }
    });
  }
  return result.sort(compareJsonFindings);
}

function visitJsonStrings(
  value: unknown,
  jsonPointer: string,
  visit: (jsonPointer: string, value: string) => void,
): void {
  if (typeof value === 'string') {
    visit(jsonPointer, value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      visitJsonStrings(entry, `${jsonPointer}/${index}`, visit),
    );
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    visitJsonStrings(
      entry,
      `${jsonPointer}/${escapeJsonPointerSegment(key)}`,
      visit,
    );
  }
}

function escapeJsonPointerSegment(value: string): string {
  return value.replace(/~/gu, '~0').replace(/\//gu, '~1');
}

function summarizeJsonSchemaIdHosts(
  findings: readonly T3JsonStringFinding[],
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const finding of findings) {
    const host = new URL(finding.normalizedValue).host;
    result[host] = (result[host] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(result).sort(([left], [right]) => compareText(left, right)),
  );
}

function summarizeJsonFindings(findings: readonly T3JsonStringFinding[]): {
  occurrences: number;
  fileCount: number;
  identityDigest: string;
} {
  return {
    occurrences: findings.length,
    fileCount: new Set(findings.map((finding) => finding.path)).size,
    identityDigest: digestJsonFindings(findings),
  };
}

function digestJsonFindings(findings: readonly T3JsonStringFinding[]): string {
  return digestText(
    findings
      .map((finding) =>
        [finding.path, finding.jsonPointer, finding.normalizedValue].join('\0'),
      )
      .sort(compareText)
      .join('\n'),
  );
}

function compareJsonFindings(
  left: T3JsonStringFinding,
  right: T3JsonStringFinding,
): number {
  return (
    compareText(left.path, right.path) ||
    compareText(left.jsonPointer, right.jsonPointer) ||
    compareText(left.normalizedValue, right.normalizedValue)
  );
}

function assertBoundaryEvidence(
  root: string,
  couplingId: string,
  evidence: T3BoundaryEvidence,
): void {
  const absolute = path.join(root, evidence.path);
  const stats = fs.lstatSync(absolute, { throwIfNoEntry: false });
  assert.ok(
    stats?.isFile() && !stats.isSymbolicLink(),
    `${couplingId} evidence must be a plain file: ${evidence.path}`,
  );
  const source = fs.readFileSync(absolute, 'utf8');
  for (const expected of evidence.contains) {
    assert.ok(
      source.includes(expected),
      `${couplingId} evidence drifted: ${evidence.path} lacks ${JSON.stringify(expected)}`,
    );
  }
}

function assertNegativeEvidence(
  root: string,
  couplingId: string,
  evidence: T3NegativeEvidence,
): void {
  for (const absentPath of evidence.absentPaths) {
    assert.equal(
      fs.lstatSync(path.join(root, absentPath), { throwIfNoEntry: false }),
      undefined,
      `${couplingId} path absence changed: ${absentPath}`,
    );
  }

  const searchable = evidence.searchRoots
    .flatMap((searchRoot) => listRegularFiles(root, searchRoot))
    .filter((file) => /\.(?:ts|js|json|md)$/u.test(file))
    .map((file) => fs.readFileSync(path.join(root, file), 'utf8'))
    .join('\n');
  for (const absentSymbol of evidence.absentSymbols) {
    assert.equal(
      searchable.includes(absentSymbol),
      false,
      `${couplingId} symbol absence changed: ${absentSymbol}`,
    );
  }
}

function listRegularFiles(root: string, relativeRoot: string): string[] {
  const absoluteRoot = path.join(root, relativeRoot);
  const rootStats = fs.lstatSync(absoluteRoot, { throwIfNoEntry: false });
  if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error(`T3 inventory scan root is unavailable: ${relativeRoot}`);
  }
  const result: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`T3 inventory scan refuses symlink: ${absolute}`);
      }
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        result.push(path.relative(root, absolute).split(path.sep).join('/'));
      }
    }
  };
  visit(absoluteRoot);
  return result.sort(compareText);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
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
  const actorSpecifier = mappedRelativeSpecifier(
    snapshot,
    GREEN_ORGANIZED_SOURCE,
    `${SRC_PREFIX}actor-identity.ts`,
  );
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

function mappedRelativeSpecifier(
  snapshot: Snapshot,
  importer: string,
  mappedSource: string,
): string {
  const row = moduleMap.find((candidate) => candidate.source === mappedSource);
  assert.ok(row, `${mappedSource} must remain in the migration map`);
  const physicalCandidates = [row.source, row.target].filter((candidate) =>
    snapshot.has(candidate),
  );
  assert.equal(
    physicalCandidates.length,
    1,
    `${mappedSource} must have one current physical path`,
  );
  let specifier = path.posix.relative(
    path.posix.dirname(importer),
    physicalCandidates[0]!,
  );
  if (!specifier.startsWith('.')) {
    specifier = `./${specifier}`;
  }
  return specifier;
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
