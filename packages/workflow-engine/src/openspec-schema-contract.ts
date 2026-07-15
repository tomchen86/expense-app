import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ExitCode, workflowError } from './errors.ts';
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
  name: 'spec-driven' | 'expense-app';
  source: 'package' | 'project';
  directory: string;
  graph: OpenSpecSchemaGraph;
  files: Record<string, OpenSpecSchemaFile>;
};

export type OpenSpecSchemaContract = {
  version: typeof PINNED_OPENSPEC_VERSION;
  packageSchema: OpenSpecSchemaSurface;
  projectSchema: OpenSpecSchemaSurface;
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

export const EXPENSE_APP_SCHEMA_DIGEST =
  '923edffcaaf8670a0324f2cfd380fe5715e286852768b120044d392e024e1019';
export const EXPENSE_APP_GUARD_TEMPLATE_DIGEST =
  'f1c44b8e477fa42dcf7d42de603e374b27073dd36e06a3f0027ab35fd16aec5a';
export const EXPENSE_APP_CONFIG_DIGEST =
  '160beaf2d52aaebd61aeec9e1808f5425acd146c4a51e0642008540ba6097c64';

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

export function schemaGraphFor(name: string): OpenSpecSchemaGraph {
  if (name === 'spec-driven') {
    return SPEC_DRIVEN_SCHEMA_GRAPH;
  }
  if (name === 'expense-app') {
    return EXPENSE_APP_SCHEMA_GRAPH;
  }
  throw invalidSchemaContract('Unsupported managed OpenSpec schema.');
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
  const packageFiles = inspectExactFiles(packageDirectory, SOURCE_FILES);
  const projectFiles = inspectExactFiles(projectDirectory, PROJECT_FILES);
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
  assertExactGraph(packageGraph, SPEC_DRIVEN_SCHEMA_GRAPH);
  assertExactGraph(projectGraph, EXPENSE_APP_SCHEMA_GRAPH);

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
    sourceDigests: { ...provenance.files },
    configPath,
    trackedPaths: [
      configPath,
      ...PROJECT_FILES.map((filePath) => path.join(projectDirectory, filePath)),
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
    rootSchemaLines[0] !== 'schema: expense-app'
  ) {
    throw invalidSchemaContract(
      'The OpenSpec project configuration must select expense-app exactly once.',
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
