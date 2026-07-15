import fs from 'node:fs';
import path from 'node:path';

export const OPENSPEC_PACKAGE_NAME = '@fission-ai/openspec';
export const OPENSPEC_PACKAGE_VERSION = '1.6.0';
export const OPENSPEC_PACKAGE_INTEGRITY =
  'sha512-7yFTQ3hrrk11mQ2ACClNv2gtAN0o116vCgwoiQKmreoB6ambSnrZh7wf2FNFoSDBXHBi9iiCQ7G16fG71ZNppA==';

export type OpenSpecSupplyChainProvenance = {
  lockfileVersion: '9.0';
  lockedVersion: string;
  integrity: typeof OPENSPEC_PACKAGE_INTEGRITY;
  buildScriptsAllowed: false;
};

type YamlLine = {
  indent: number;
  text: string;
};

type LineRange = { start: number; end: number };

export function verifyOpenSpecSupplyChain(
  repositoryRoot: string,
): OpenSpecSupplyChainProvenance {
  const workspace = significantYamlLines(
    readCanonicalTextFile(repositoryRoot, 'pnpm-workspace.yaml'),
  );
  const allowBuilds = uniqueLine(
    workspace,
    wholeFile(workspace),
    0,
    (line) => line.text === 'allowBuilds:',
  );
  const buildPolicy = linesInBlock(workspace, allowBuilds);
  uniqueLine(
    workspace,
    buildPolicy,
    2,
    (line) => line.text === `'${OPENSPEC_PACKAGE_NAME}': false`,
  );
  if (
    matchingLines(workspace, buildPolicy, 2, (line) =>
      line.text.startsWith(`'${OPENSPEC_PACKAGE_NAME}':`),
    ).length !== 1
  ) {
    throw new Error('OpenSpec build policy is ambiguous');
  }

  const lock = significantYamlLines(
    readCanonicalTextFile(repositoryRoot, 'pnpm-lock.yaml'),
  );
  uniqueLine(
    lock,
    wholeFile(lock),
    0,
    (line) => line.text === "lockfileVersion: '9.0'",
  );

  const importers = uniqueLine(
    lock,
    wholeFile(lock),
    0,
    (line) => line.text === 'importers:',
  );
  const rootImporter = uniqueLine(
    lock,
    linesInBlock(lock, importers),
    2,
    (line) => line.text === '.:',
  );
  const developmentDependencies = uniqueLine(
    lock,
    linesInBlock(lock, rootImporter),
    4,
    (line) => line.text === 'devDependencies:',
  );
  const dependency = uniqueLine(
    lock,
    linesInBlock(lock, developmentDependencies),
    6,
    (line) => line.text === `'${OPENSPEC_PACKAGE_NAME}':`,
  );
  const dependencyBlock = linesInBlock(lock, dependency);
  uniqueLine(
    lock,
    dependencyBlock,
    8,
    (line) => line.text === `specifier: ${OPENSPEC_PACKAGE_VERSION}`,
  );
  const versionLine = uniqueLine(lock, dependencyBlock, 8, (line) =>
    line.text.startsWith('version: '),
  );
  const lockedVersion = versionLine.text.slice('version: '.length);
  if (!isPinnedSnapshotVersion(lockedVersion)) {
    throw new Error('OpenSpec lock importer version is not pinned');
  }

  const packages = uniqueLine(
    lock,
    wholeFile(lock),
    0,
    (line) => line.text === 'packages:',
  );
  const packageRange = linesInBlock(lock, packages);
  const packageEntry = uniqueLine(
    lock,
    packageRange,
    2,
    (line) => line.text === `'${OPENSPEC_PACKAGE_NAME}@1.6.0':`,
  );
  if (
    matchingLines(lock, packageRange, 2, (line) =>
      line.text.startsWith(`'${OPENSPEC_PACKAGE_NAME}@`),
    ).length !== 1
  ) {
    throw new Error('OpenSpec lock package entry is ambiguous');
  }
  const packageBlock = linesInBlock(lock, packageEntry);
  uniqueLine(
    lock,
    packageBlock,
    4,
    (line) =>
      line.text === `resolution: {integrity: ${OPENSPEC_PACKAGE_INTEGRITY}}`,
  );
  uniqueLine(lock, packageBlock, 4, (line) => line.text === 'hasBin: true');

  const snapshots = uniqueLine(
    lock,
    wholeFile(lock),
    0,
    (line) => line.text === 'snapshots:',
  );
  const snapshotRange = linesInBlock(lock, snapshots);
  uniqueLine(
    lock,
    snapshotRange,
    2,
    (line) =>
      line.text === `'${OPENSPEC_PACKAGE_NAME}@${lockedVersion}':` ||
      line.text === `'${OPENSPEC_PACKAGE_NAME}@${lockedVersion}': {}`,
  );
  if (
    matchingLines(lock, snapshotRange, 2, (line) =>
      line.text.startsWith(`'${OPENSPEC_PACKAGE_NAME}@`),
    ).length !== 1
  ) {
    throw new Error('OpenSpec lock snapshot is ambiguous');
  }

  return {
    lockfileVersion: '9.0',
    lockedVersion,
    integrity: OPENSPEC_PACKAGE_INTEGRITY,
    buildScriptsAllowed: false,
  };
}

function readCanonicalTextFile(
  repositoryRoot: string,
  relativePath: string,
): string {
  const filePath = path.join(repositoryRoot, relativePath);
  const stats = fs.lstatSync(filePath);
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    fs.realpathSync(filePath) !== filePath ||
    stats.size > 16 * 1024 * 1024
  ) {
    throw new Error('OpenSpec provenance file is unsafe');
  }
  const bytes = fs.readFileSync(filePath);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (text.charCodeAt(0) === 0xfeff || text.includes('\0')) {
    throw new Error('OpenSpec provenance file is malformed');
  }
  return text;
}

function significantYamlLines(source: string): YamlLine[] {
  const lines: YamlLine[] = [];
  for (const rawLine of source.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.includes('\t')) {
      throw new Error('OpenSpec provenance YAML contains a tab');
    }
    const text = line.trim();
    if (!text || text.startsWith('#')) {
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (indent % 2 !== 0) {
      throw new Error('OpenSpec provenance YAML indentation is unsupported');
    }
    lines.push({ indent, text });
  }
  return lines;
}

function wholeFile(lines: YamlLine[]): LineRange {
  return { start: 0, end: lines.length };
}

function linesInBlock(lines: YamlLine[], parent: YamlLine): LineRange {
  const parentIndex = lines.indexOf(parent);
  let end = parentIndex + 1;
  while (end < lines.length && lines[end]!.indent > parent.indent) {
    end += 1;
  }
  return { start: parentIndex + 1, end };
}

function uniqueLine(
  lines: YamlLine[],
  range: LineRange,
  indent: number,
  predicate: (line: YamlLine) => boolean,
): YamlLine {
  const matches = matchingLines(lines, range, indent, predicate);
  if (matches.length !== 1) {
    throw new Error('OpenSpec provenance YAML shape differs from policy');
  }
  return matches[0]!;
}

function matchingLines(
  lines: YamlLine[],
  range: LineRange,
  indent: number,
  predicate: (line: YamlLine) => boolean,
): YamlLine[] {
  return lines
    .slice(range.start, range.end)
    .filter((line) => line.indent === indent && predicate(line));
}

function isPinnedSnapshotVersion(value: string): boolean {
  return /^1\.6\.0(?:\([a-zA-Z0-9@+._/-]+\))*$/.test(value);
}
