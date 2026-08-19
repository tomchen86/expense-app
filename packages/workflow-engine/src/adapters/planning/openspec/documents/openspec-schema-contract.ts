import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  ExitCode,
  workflowError,
} from '../../../../foundation/errors/errors.ts';
import {
  protectedBranchRef,
  runGit,
} from '../../../../runtime/repository-transaction/git.ts';
import {
  PINNED_OPENSPEC_VERSION,
  resolveOpenSpecInstallation,
} from './openspec-executor.ts';
import { OPENSPEC_PACKAGE_NAME } from './openspec-provenance.ts';

export type OpenSpecSchemaArtifact = {
  id: string;
  generates: string;
  template: string;
  requires: string[];
};

export type OpenSpecSchemaGraph = {
  name: string;
  version: 1;
  artifacts: OpenSpecSchemaArtifact[];
  apply: { requires: string[]; tracks: string };
};

export type OpenSpecSchemaFile = {
  path: string;
  digest: string;
  mode: '100644';
};

export type OpenSpecSchemaSurface = {
  name: 'spec-driven' | 'expense-app' | 'expense-app-v2';
  source: 'package' | 'project';
  directory: string;
  graph: OpenSpecSchemaGraph;
  files: Record<string, OpenSpecSchemaFile>;
};

export type OpenSpecSchemaContract = {
  version: typeof PINNED_OPENSPEC_VERSION;
  packageSchema: OpenSpecSchemaSurface;
  projectSchema: OpenSpecSchemaSurface;
  projectSchemaV2: OpenSpecSchemaSurface;
  sourceDigests: Record<string, string>;
  configPath: string;
  trackedPaths: string[];
};

const SOURCE_FILES = [
  'schema.yaml',
  'templates/proposal.md',
  'templates/spec.md',
  'templates/design.md',
  'templates/tasks.md',
] as const;

const PROJECT_FILES = [
  'provenance.json',
  'schema.yaml',
  'templates/design.md',
  'templates/guard.json',
  'templates/proposal.md',
  'templates/spec.md',
  'templates/tasks.md',
] as const;

const PROJECT_V2_FILES = [
  'provenance.json',
  'schema.yaml',
  'templates/design.md',
  'templates/execution.json',
  'templates/guard.json',
  'templates/investigation.json',
  'templates/plan-review.json',
  'templates/proposal.md',
  'templates/spec.md',
  'templates/tasks.md',
] as const;

export const EXPENSE_APP_SCHEMA_DIGEST =
  '923edffcaaf8670a0324f2cfd380fe5715e286852768b120044d392e024e1019';
export const EXPENSE_APP_GUARD_TEMPLATE_DIGEST =
  'f1c44b8e477fa42dcf7d42de603e374b27073dd36e06a3f0027ab35fd16aec5a';
export const EXPENSE_APP_CONFIG_DIGEST =
  '74c82a62f2623c7fcb776ab9813b2f9741aff356d1542f5edb2cc49a101cb17a';

/**
 * The reviewed activation marker for investigation-first planning. The first
 * commit that introduces this exact file is the activation anchor.
 */
export const INVESTIGATION_PLANNING_ACTIVATION_MARKER =
  'workflow/schemas/investigation-planning-v1.schema.json';

export const INVESTIGATION_PLANNING_ACTIVATION_DIGEST =
  'adf4c3e3d28db1b208792e3b5acb0a8e792b010931d377cd70bbb52df37681c7';

const EXPENSE_APP_V2_FILE_DIGESTS: Record<
  (typeof PROJECT_V2_FILES)[number],
  string
> = {
  'provenance.json':
    'c83ec0dfb200ab7e2b6ad8284c62389c66f6bf5c4b93384560933d255995f55d',
  'schema.yaml':
    '910e97a4eb6e1797cf453b1a7c54f5207ccb504ab2dfceac94939ea7808a329f',
  'templates/design.md':
    '037c25fcd0b9b6567627a8d27cbff946f1fe76cd906f25b7b691c6ef57d1e779',
  'templates/execution.json':
    '142eb08e4a27940db0c18fd0ab487e965da2420bc522eda7d988e176ceaa0185',
  'templates/guard.json':
    'f1c44b8e477fa42dcf7d42de603e374b27073dd36e06a3f0027ab35fd16aec5a',
  'templates/investigation.json':
    '09772d00adc2bc37c880d9273d765cf64209466d4c97a4a0803e2ce1d07d99aa',
  'templates/plan-review.json':
    'bf92aa9a2682622fb6a7513295af3d260adc0c48ee64e5e7ff6e77ce415e2fac',
  'templates/proposal.md':
    '9c554e0dbe918e3dc745dcc143a999e1d102954d75fb6e51e231c4cba78f06f3',
  'templates/spec.md':
    'e025078f238dc6e4df552a1e0a140cf9efce0bbdecbeb9f45837d45ed91dca01',
  'templates/tasks.md':
    'b2a6a4c08c15f347a1d8c3e2d43e0c8fb066dc5cc0feb795f47555f176f9c421',
};

export const SPEC_DRIVEN_SCHEMA_GRAPH: OpenSpecSchemaGraph = {
  name: 'spec-driven',
  version: 1,
  artifacts: [
    {
      id: 'proposal',
      generates: 'proposal.md',
      template: 'proposal.md',
      requires: [],
    },
    {
      id: 'specs',
      generates: 'specs/**/*.md',
      template: 'spec.md',
      requires: ['proposal'],
    },
    {
      id: 'design',
      generates: 'design.md',
      template: 'design.md',
      requires: ['proposal'],
    },
    {
      id: 'tasks',
      generates: 'tasks.md',
      template: 'tasks.md',
      requires: ['specs', 'design'],
    },
  ],
  apply: { requires: ['tasks'], tracks: 'tasks.md' },
};

export const EXPENSE_APP_SCHEMA_GRAPH: OpenSpecSchemaGraph = {
  ...SPEC_DRIVEN_SCHEMA_GRAPH,
  name: 'expense-app',
  artifacts: [
    ...SPEC_DRIVEN_SCHEMA_GRAPH.artifacts.map((artifact) => ({
      ...artifact,
      requires: [...artifact.requires],
    })),
    {
      id: 'guard',
      generates: 'guard.json',
      template: 'guard.json',
      requires: ['tasks'],
    },
  ],
  apply: { requires: ['tasks', 'guard'], tracks: 'tasks.md' },
};

export const EXPENSE_APP_V2_SCHEMA_GRAPH: OpenSpecSchemaGraph = {
  name: 'expense-app-v2',
  version: 1,
  artifacts: [
    {
      id: 'investigation',
      generates: 'investigation.json',
      template: 'investigation.json',
      requires: [],
    },
    {
      id: 'proposal',
      generates: 'proposal.md',
      template: 'proposal.md',
      requires: ['investigation'],
    },
    {
      id: 'specs',
      generates: 'specs/**/*.md',
      template: 'spec.md',
      requires: ['proposal'],
    },
    {
      id: 'design',
      generates: 'design.md',
      template: 'design.md',
      requires: ['proposal'],
    },
    {
      id: 'tasks',
      generates: 'tasks.md',
      template: 'tasks.md',
      requires: ['specs', 'design'],
    },
    {
      id: 'guard',
      generates: 'guard.json',
      template: 'guard.json',
      requires: ['tasks'],
    },
    {
      id: 'execution',
      generates: 'execution.json',
      template: 'execution.json',
      requires: ['tasks'],
    },
    {
      id: 'plan-review',
      generates: 'plan-review.json',
      template: 'plan-review.json',
      requires: ['guard', 'execution'],
    },
  ],
  apply: {
    requires: ['investigation', 'tasks', 'guard', 'execution', 'plan-review'],
    tracks: 'tasks.md',
  },
};

export function schemaGraphFor(name: string): OpenSpecSchemaGraph {
  if (name === 'spec-driven') {
    return SPEC_DRIVEN_SCHEMA_GRAPH;
  }
  if (name === 'expense-app') {
    return EXPENSE_APP_SCHEMA_GRAPH;
  }
  if (name === 'expense-app-v2') {
    return EXPENSE_APP_V2_SCHEMA_GRAPH;
  }
  throw invalidSchemaContract('Unsupported managed OpenSpec schema.');
}

export type InvestigationPlanningActivation = {
  activated: boolean;
  anchor: string | null;
};

/**
 * Decide whether investigation-first planning is active for a candidate by
 * commit ancestry alone. Activation is monotonic: the anchor is the first
 * commit that introduced the reviewed marker anywhere in the applicable
 * lineage, so a later commit that deletes or renames the file cannot walk the
 * repository back to the legacy grammar. Callers pass every applicable
 * baseline — the candidate parent for a planning transition, the replayed
 * governing lineage for historical validation, and the configured protected
 * base when the candidate is not already contained in it — and activation
 * holds if any one of them reaches an anchor.
 */
export function resolveInvestigationPlanningActivation(
  repositoryRoot: string,
  baselines: readonly string[],
): InvestigationPlanningActivation {
  for (const baseline of baselines) {
    const anchor = firstActivationAnchor(repositoryRoot, baseline);
    if (anchor !== null) {
      return { activated: true, anchor };
    }
  }
  return { activated: false, anchor: null };
}

/**
 * The configured protected-base lineage, resolved through the same
 * remote-tracking spelling archive eligibility and maintainer attestation use.
 * A repository with no workflow policy, or with no protected ref that
 * resolves, contributes no additional baseline: the candidate's own lineage
 * still decides activation, so an absent protected base can never restore
 * legacy eligibility to a candidate whose parent already reaches an anchor.
 */
export function protectedActivationBaselines(repositoryRoot: string): string[] {
  let branches: string[];
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(
        path.join(repositoryRoot, 'workflow/config.json'),
        'utf8',
      ),
    );
    const protectedBranches =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>).protectedBranches
        : undefined;
    branches = Array.isArray(protectedBranches)
      ? protectedBranches.filter((branch) => typeof branch === 'string')
      : [];
  } catch {
    return [];
  }
  const baselines: string[] = [];
  for (const branch of branches) {
    const resolved = resolveCommit(
      repositoryRoot,
      `${protectedBranchRef(branch)}^{commit}`,
    );
    if (resolved !== null && !baselines.includes(resolved)) {
      baselines.push(resolved);
    }
  }
  return baselines;
}

/**
 * Enforce the activated selection for one candidate. Once activation is
 * reachable the exact reviewed marker must still be present in the validated
 * tree, and any legacy declaration is a downgrade attempt rather than a
 * pre-activation generation.
 */
export function assertInvestigationPlanningActivation(request: {
  repositoryRoot: string;
  baselines: readonly string[];
  readMarker: () => Buffer | string | undefined;
  declaredSchemaName?: 'expense-app' | 'expense-app-v2';
}): InvestigationPlanningActivation {
  const activation = resolveInvestigationPlanningActivation(
    request.repositoryRoot,
    request.baselines,
  );
  if (!activation.activated) {
    return activation;
  }
  // A legacy declaration is reported as the downgrade it is even when the
  // candidate tree also omits the marker, which is exactly the shape of a
  // stale pre-activation branch proposed after the protected base activated.
  if (
    request.declaredSchemaName !== undefined &&
    request.declaredSchemaName !== 'expense-app-v2'
  ) {
    throw workflowError(
      'PLANNING_SCHEMA_DOWNGRADE',
      'Investigation-first planning is active; this generation must declare expense-app-v2.',
      ExitCode.guard,
      {
        details: {
          anchor: activation.anchor,
          declaredSchemaName: request.declaredSchemaName,
        },
      },
    );
  }
  const marker = request.readMarker();
  const digest =
    marker === undefined
      ? null
      : crypto
          .createHash('sha256')
          .update(typeof marker === 'string' ? Buffer.from(marker) : marker)
          .digest('hex');
  if (digest !== INVESTIGATION_PLANNING_ACTIVATION_DIGEST) {
    throw workflowError(
      'INVESTIGATION_ACTIVATION_MARKER_INVALID',
      'The reviewed investigation-planning activation marker is missing or altered.',
      ExitCode.verification,
      {
        details: {
          marker: INVESTIGATION_PLANNING_ACTIVATION_MARKER,
          anchor: activation.anchor,
        },
      },
    );
  }
  return activation;
}

/**
 * The activation marker as it exists in one checkout or materialized tree. A
 * symlink or non-regular entry reads as absent so a replaced marker can never
 * satisfy the digest through a redirect.
 */
export function readActivationMarkerFile(treeRoot: string): Buffer | undefined {
  const markerPath = path.join(
    treeRoot,
    INVESTIGATION_PLANNING_ACTIVATION_MARKER,
  );
  const stats = fs.lstatSync(markerPath, { throwIfNoEntry: false });
  return stats?.isFile() && !stats.isSymbolicLink()
    ? fs.readFileSync(markerPath)
    : undefined;
}

function firstActivationAnchor(
  repositoryRoot: string,
  baseline: string,
): string | null {
  const commit = resolveCommit(repositoryRoot, `${baseline}^{commit}`);
  if (commit === null) {
    throw workflowError(
      'INVESTIGATION_ACTIVATION_UNRESOLVED',
      'An investigation-planning activation baseline does not resolve to a commit.',
      ExitCode.verification,
      { details: { baseline } },
    );
  }
  // `--full-history` keeps every side of a merge, so activation introduced on
  // a merged branch is never simplified away; `--topo-order --reverse` makes
  // the oldest introduction the deterministic first entry.
  const anchors = runGit(repositoryRoot, [
    'rev-list',
    '--full-history',
    '--topo-order',
    '--reverse',
    commit,
    '--',
    INVESTIGATION_PLANNING_ACTIVATION_MARKER,
  ])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return anchors[0] ?? null;
}

function resolveCommit(
  repositoryRoot: string,
  revision: string,
): string | null {
  const resolved = runGit(
    repositoryRoot,
    ['rev-parse', '--verify', '--quiet', revision],
    true,
  ).trim();
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(resolved) ? resolved : null;
}

export function inspectOpenSpecSchemaContract(
  repositoryRoot: string,
): OpenSpecSchemaContract {
  const installation = resolveOpenSpecInstallation(repositoryRoot);
  const packageDirectory = path.join(
    installation.packageDirectory,
    'schemas/spec-driven',
  );
  const projectDirectory = path.join(
    installation.repositoryRoot,
    'openspec/schemas/expense-app',
  );
  const projectV2Directory = path.join(
    installation.repositoryRoot,
    'openspec/schemas/expense-app-v2',
  );
  const packageFiles = inspectExactFiles(packageDirectory, SOURCE_FILES);
  const projectFiles = inspectExactFiles(projectDirectory, PROJECT_FILES);
  const projectV2Files = inspectExactFiles(
    projectV2Directory,
    PROJECT_V2_FILES,
  );
  for (const filePath of PROJECT_V2_FILES) {
    if (
      projectV2Files[filePath]?.digest !== EXPENSE_APP_V2_FILE_DIGESTS[filePath]
    ) {
      throw invalidSchemaContract(
        'The project v2 OpenSpec schema content differs from the reviewed contract.',
      );
    }
  }
  const configPath = inspectProjectConfig(installation.repositoryRoot);
  const provenance = parseProvenance(
    fs.readFileSync(path.join(projectDirectory, 'provenance.json'), 'utf8'),
  );
  if (projectFiles['schema.yaml']?.digest !== EXPENSE_APP_SCHEMA_DIGEST) {
    throw invalidSchemaContract(
      'The project OpenSpec schema content differs from the reviewed contract.',
    );
  }
  if (
    projectFiles['templates/guard.json']?.digest !==
    EXPENSE_APP_GUARD_TEMPLATE_DIGEST
  ) {
    throw invalidSchemaContract(
      'The project guard template differs from the reviewed contract.',
    );
  }

  for (const sourcePath of SOURCE_FILES) {
    const observedSource = packageFiles[sourcePath];
    const observedProject =
      sourcePath === 'schema.yaml' ? undefined : projectFiles[sourcePath];
    const expectedDigest = provenance.files[sourcePath];
    if (
      !observedSource ||
      observedSource.digest !== expectedDigest ||
      (observedProject && observedProject.digest !== expectedDigest)
    ) {
      throw invalidSchemaContract(
        'The project schema provenance does not match the pinned package source.',
      );
    }
  }

  const packageGraph = parseSchemaGraph(
    fs.readFileSync(path.join(packageDirectory, 'schema.yaml'), 'utf8'),
  );
  const projectGraph = parseSchemaGraph(
    fs.readFileSync(path.join(projectDirectory, 'schema.yaml'), 'utf8'),
  );
  const projectV2Graph = parseSchemaGraph(
    fs.readFileSync(path.join(projectV2Directory, 'schema.yaml'), 'utf8'),
  );
  assertExactGraph(packageGraph, SPEC_DRIVEN_SCHEMA_GRAPH);
  assertExactGraph(projectGraph, EXPENSE_APP_SCHEMA_GRAPH);
  assertExactGraph(projectV2Graph, EXPENSE_APP_V2_SCHEMA_GRAPH);

  const v2Provenance = parseProvenance(
    fs.readFileSync(path.join(projectV2Directory, 'provenance.json'), 'utf8'),
  );
  for (const sourcePath of SOURCE_FILES) {
    if (v2Provenance.files[sourcePath] !== provenance.files[sourcePath]) {
      throw invalidSchemaContract(
        'The v2 schema provenance does not match the pinned package source.',
      );
    }
  }
  for (const sourcePath of [
    'templates/proposal.md',
    'templates/spec.md',
    'templates/tasks.md',
  ] as const) {
    if (
      projectV2Files[sourcePath]?.digest !== packageFiles[sourcePath]?.digest
    ) {
      throw invalidSchemaContract(
        'The v2 authored templates do not match the pinned package source.',
      );
    }
  }
  if (
    projectV2Files['templates/guard.json']?.digest !==
    projectFiles['templates/guard.json']?.digest
  ) {
    throw invalidSchemaContract(
      'The v2 guard template does not match the reviewed legacy policy template.',
    );
  }

  return {
    version: PINNED_OPENSPEC_VERSION,
    packageSchema: {
      name: 'spec-driven',
      source: 'package',
      directory: packageDirectory,
      graph: packageGraph,
      files: packageFiles,
    },
    projectSchema: {
      name: 'expense-app',
      source: 'project',
      directory: projectDirectory,
      graph: projectGraph,
      files: projectFiles,
    },
    projectSchemaV2: {
      name: 'expense-app-v2',
      source: 'project',
      directory: projectV2Directory,
      graph: projectV2Graph,
      files: projectV2Files,
    },
    sourceDigests: { ...provenance.files },
    configPath,
    trackedPaths: [
      configPath,
      ...PROJECT_FILES.map((filePath) => path.join(projectDirectory, filePath)),
      ...PROJECT_V2_FILES.map((filePath) =>
        path.join(projectV2Directory, filePath),
      ),
    ].sort(),
  };
}

function inspectExactFiles(
  directory: string,
  expectedPaths: readonly string[],
): Record<string, OpenSpecSchemaFile> {
  const root = assertCanonicalDirectory(directory);
  const files: Record<string, OpenSpecSchemaFile> = {};
  walk(root);
  const observedPaths = Object.keys(files).sort();
  const expected = [...expectedPaths].sort();
  if (JSON.stringify(observedPaths) !== JSON.stringify(expected)) {
    throw invalidSchemaContract(
      'An OpenSpec schema directory does not contain the exact managed file set.',
    );
  }
  return files;

  function walk(current: string): void {
    assertCanonicalDirectory(current);
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolutePath = path.join(current, entry.name);
      const stats = fs.lstatSync(absolutePath);
      if (stats.isSymbolicLink()) {
        throw invalidSchemaContract(
          'OpenSpec schema files cannot be symlinks.',
        );
      }
      if (stats.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      if (
        !stats.isFile() ||
        fs.realpathSync(absolutePath) !== absolutePath ||
        (stats.mode & 0o111) !== 0
      ) {
        throw invalidSchemaContract(
          'OpenSpec schema assets must be canonical non-executable regular files.',
        );
      }
      const relativePath = path
        .relative(root, absolutePath)
        .split(path.sep)
        .join('/');
      files[relativePath] = {
        path: absolutePath,
        digest: crypto
          .createHash('sha256')
          .update(fs.readFileSync(absolutePath))
          .digest('hex'),
        mode: '100644',
      };
    }
  }
}

function inspectProjectConfig(repositoryRoot: string): string {
  const configPath = path.join(repositoryRoot, 'openspec/config.yaml');
  let content: string;
  try {
    const stats = fs.lstatSync(configPath);
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      (stats.mode & 0o111) !== 0 ||
      fs.realpathSync(configPath) !== configPath
    ) {
      throw new Error('unsafe OpenSpec config');
    }
    const bytes = fs.readFileSync(configPath);
    if (
      crypto.createHash('sha256').update(bytes).digest('hex') !==
      EXPENSE_APP_CONFIG_DIGEST
    ) {
      throw new Error('OpenSpec config digest differs');
    }
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw invalidSchemaContract(
      'The OpenSpec project configuration is not a canonical regular file.',
    );
  }
  if (
    content.includes('\r') ||
    content.includes('\t') ||
    content.includes('\0')
  ) {
    throw invalidSchemaContract(
      'The OpenSpec project configuration is malformed.',
    );
  }
  const rootSchemaLines = content
    .split('\n')
    .filter((line) => /^schema:/.test(line));
  if (
    rootSchemaLines.length !== 1 ||
    rootSchemaLines[0] !== 'schema: expense-app-v2'
  ) {
    throw invalidSchemaContract(
      'The OpenSpec project configuration must select expense-app-v2 exactly once.',
    );
  }
  return configPath;
}

function assertCanonicalDirectory(directory: string): string {
  try {
    const absolutePath = path.resolve(directory);
    const stats = fs.lstatSync(absolutePath);
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      fs.realpathSync(absolutePath) !== absolutePath
    ) {
      throw new Error('unsafe schema directory');
    }
    return absolutePath;
  } catch {
    throw invalidSchemaContract(
      'OpenSpec schema directories must be canonical and cannot be symlinked.',
    );
  }
}

function parseProvenance(content: string): {
  files: Record<(typeof SOURCE_FILES)[number], string>;
} {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw invalidSchemaContract(
      'OpenSpec schema provenance is not valid JSON.',
    );
  }
  const provenance = record(value);
  const source = record(provenance.source);
  const files = record(source.files);
  if (
    !hasExactKeys(provenance, ['schemaVersion', 'source']) ||
    provenance.schemaVersion !== 1 ||
    !hasExactKeys(source, ['files', 'package', 'path', 'schema', 'version']) ||
    source.package !== OPENSPEC_PACKAGE_NAME ||
    source.version !== PINNED_OPENSPEC_VERSION ||
    source.schema !== 'spec-driven' ||
    source.path !== 'schemas/spec-driven' ||
    !hasExactKeys(files, [...SOURCE_FILES]) ||
    Object.values(files).some(
      (digest) => typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest),
    )
  ) {
    throw invalidSchemaContract(
      'OpenSpec schema provenance does not match the exact pinned source contract.',
    );
  }
  return {
    files: Object.fromEntries(
      SOURCE_FILES.map((filePath) => [filePath, String(files[filePath])]),
    ) as Record<(typeof SOURCE_FILES)[number], string>,
  };
}

function parseSchemaGraph(content: string): OpenSpecSchemaGraph {
  if (
    !content.endsWith('\n') ||
    content.includes('\r') ||
    content.includes('\t')
  ) {
    throw invalidSchemaContract('OpenSpec schema YAML is not canonical text.');
  }
  const lines = content.split('\n');
  const name = scalar(lines, /^name: (.+)$/);
  if (scalar(lines, /^version: (.+)$/) !== '1') {
    throw invalidSchemaContract('OpenSpec schema version is not supported.');
  }
  const artifactStarts = lines
    .map((line, index) => (/^ {2}- id: (.+)$/.test(line) ? index : -1))
    .filter((index) => index >= 0);
  const applyIndex = lines.findIndex((line) => line === 'apply:');
  if (artifactStarts.length === 0 || applyIndex < 0) {
    throw invalidSchemaContract('OpenSpec schema graph is incomplete.');
  }
  const artifacts = artifactStarts.map((start, index) => {
    const end = artifactStarts[index + 1] ?? applyIndex;
    if (end <= start) {
      throw invalidSchemaContract('OpenSpec schema graph ordering is invalid.');
    }
    const section = lines.slice(start, end);
    const fields = schemaFields(section, 4);
    if (
      !hasExactMembers(Object.keys(fields), [
        'description',
        'generates',
        'instruction',
        'requires',
        'template',
      ]) ||
      fields.instruction !== '|' ||
      !fields.description
    ) {
      throw invalidSchemaContract('OpenSpec artifact fields are not exact.');
    }
    return {
      id: section[0]!.slice('  - id: '.length),
      generates: unquote(fields.generates),
      template: unquote(fields.template),
      requires: parseListField(section, 'requires', 4),
    };
  });
  const applySection = lines.slice(applyIndex + 1);
  const applyFields = schemaFields(applySection, 2);
  if (
    !hasExactMembers(Object.keys(applyFields), [
      'instruction',
      'requires',
      'tracks',
    ]) ||
    applyFields.instruction !== '|'
  ) {
    throw invalidSchemaContract('OpenSpec apply fields are not exact.');
  }
  return {
    name,
    version: 1,
    artifacts,
    apply: {
      requires: parseListField(applySection, 'requires', 2),
      tracks: unquote(applyFields.tracks),
    },
  };
}

function schemaFields(
  lines: string[],
  indentation: number,
): Record<string, string> {
  const fields: Record<string, string> = {};
  const prefix = ' '.repeat(indentation);
  const pattern = new RegExp(`^${prefix}([a-z][a-zA-Z]*):(?: (.*))?$`);
  for (const line of lines) {
    const match = pattern.exec(line);
    if (!match) {
      continue;
    }
    if (Object.hasOwn(fields, match[1])) {
      throw invalidSchemaContract(
        'OpenSpec schema contains a duplicate field.',
      );
    }
    fields[match[1]] = match[2] ?? '';
  }
  return fields;
}

function parseListField(
  lines: string[],
  field: string,
  indentation: number,
): string[] {
  const prefix = ' '.repeat(indentation);
  const index = lines.findIndex((line) =>
    line.startsWith(`${prefix}${field}:`),
  );
  if (index < 0) {
    throw invalidSchemaContract('OpenSpec schema is missing a list field.');
  }
  const inline = lines[index]!.slice(`${prefix}${field}:`.length).trim();
  if (inline) {
    if (inline === '[]') {
      return [];
    }
    const match = /^\[([^\]]+)\]$/.exec(inline);
    if (!match) {
      throw invalidSchemaContract('OpenSpec schema list syntax is invalid.');
    }
    return match[1].split(',').map((value) => value.trim());
  }
  const itemPrefix = `${' '.repeat(indentation + 2)}- `;
  const values: string[] = [];
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor]!;
    if (!line.startsWith(itemPrefix)) {
      break;
    }
    values.push(line.slice(itemPrefix.length));
  }
  return values;
}

function scalar(lines: string[], pattern: RegExp): string {
  const matches = lines.map((line) => pattern.exec(line)).filter(Boolean);
  if (matches.length !== 1 || !matches[0]?.[1]) {
    throw invalidSchemaContract(
      'OpenSpec schema scalar is missing or duplicate.',
    );
  }
  return unquote(matches[0][1]);
}

function unquote(value: string): string {
  const doubleQuoted = /^"([^"\\]*)"$/.exec(value);
  const plain = /^[a-zA-Z0-9*./-]+$/.test(value);
  if (doubleQuoted) {
    return doubleQuoted[1];
  }
  if (plain) {
    return value;
  }
  throw invalidSchemaContract('OpenSpec schema contains an unsafe scalar.');
}

function assertExactGraph(
  observed: OpenSpecSchemaGraph,
  expected: OpenSpecSchemaGraph,
): void {
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    throw invalidSchemaContract(
      'OpenSpec schema artifact graph differs from the managed contract.',
    );
  }
}

function hasExactMembers(observed: string[], expected: string[]): boolean {
  return (
    observed.length === expected.length &&
    observed.every((value) => expected.includes(value))
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: string[],
): boolean {
  return hasExactMembers(Object.keys(value), expected);
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidSchemaContract('OpenSpec schema provenance is not an object.');
  }
  return value as Record<string, unknown>;
}

function invalidSchemaContract(message: string) {
  return workflowError(
    'OPENSPEC_SCHEMA_CONTRACT_INVALID',
    message,
    ExitCode.verification,
  );
}
