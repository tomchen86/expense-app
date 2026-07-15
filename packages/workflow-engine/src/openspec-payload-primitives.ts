import fs from 'node:fs';
import path from 'node:path';

import { ExitCode, workflowError } from './errors.ts';

export function parseRoot(
  value: unknown,
  repositoryRoot: string,
): { path: string; source: 'nearest' } {
  const root = record(value);
  if (
    root.path !== repositoryRoot ||
    root.source !== 'nearest' ||
    Object.keys(root).some((key) => !['path', 'source'].includes(key))
  ) {
    throw invalidPayload();
  }
  return { path: repositoryRoot, source: 'nearest' };
}

export function parsePlanningHome(
  value: unknown,
  repositoryRoot: string,
): void {
  const planningHome = record(value);
  if (
    planningHome.kind !== 'repo' ||
    planningHome.root !== repositoryRoot ||
    planningHome.changesDir !== path.join(repositoryRoot, 'openspec/changes') ||
    planningHome.defaultSchema !== 'spec-driven' ||
    Object.hasOwn(planningHome, 'store_id')
  ) {
    throw invalidPayload();
  }
}

export function parseArtifactPaths(
  value: unknown,
  changeRoot: string,
): {
  outputPath: string;
  resolvedOutputPath: string;
  existingOutputPaths: string[];
} {
  const artifact = record(value);
  const outputPath = assertSafeOutputPath(artifact.outputPath);
  const resolvedOutputPath = path.join(changeRoot, outputPath);
  if (
    artifact.resolvedOutputPath !== resolvedOutputPath ||
    !Array.isArray(artifact.existingOutputPaths)
  ) {
    throw invalidPayload();
  }
  const existingOutputPaths = artifact.existingOutputPaths.map((entry) =>
    assertExistingFile(changeRoot, entry, outputPath),
  );
  assertUnique(existingOutputPaths);
  return { outputPath, resolvedOutputPath, existingOutputPaths };
}

export function assertSafeOutputPath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.includes('\\') ||
    path.posix.isAbsolute(value) ||
    /^[a-zA-Z]:/.test(value) ||
    hasControlCharacter(value) ||
    value
      .split('/')
      .some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw invalidPayload();
  }
  return value;
}

export function safeIdentifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    throw invalidPayload();
  }
  return value;
}

export function identifierArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw invalidPayload();
  }
  const identifiers = value.map(safeIdentifier);
  assertUnique(identifiers);
  return identifiers;
}

export function assertSameMembers(left: string[], right: string[]): void {
  if (
    left.length !== right.length ||
    left.some((value) => !right.includes(value))
  ) {
    throw invalidPayload();
  }
}

export function isCanonicalIsoDate(value: string): boolean {
  const milliseconds = Date.parse(value);
  return (
    !Number.isNaN(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

export function parseSchemaIssue(value: unknown): Record<string, unknown> {
  const issue = record(value);
  if (
    issue.level !== 'error' ||
    typeof issue.path !== 'string' ||
    !issue.path ||
    typeof issue.message !== 'string' ||
    !issue.message ||
    Object.keys(issue).some(
      (key) => !['level', 'path', 'message'].includes(key),
    )
  ) {
    throw invalidPayload();
  }
  return issue;
}

export function parseIssue(value: unknown): Record<string, unknown> {
  const issue = record(value);
  if (
    !['ERROR', 'WARNING', 'INFO'].includes(String(issue.level)) ||
    typeof issue.path !== 'string' ||
    !issue.path ||
    typeof issue.message !== 'string' ||
    !issue.message ||
    !optionalPositiveInteger(issue.line) ||
    !optionalPositiveInteger(issue.column) ||
    Object.keys(issue).some(
      (key) => !['level', 'path', 'message', 'line', 'column'].includes(key),
    )
  ) {
    throw invalidPayload();
  }
  return issue;
}

export function nonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw invalidPayload();
  }
  return Number(value);
}

export function assertUnique(values: string[]): void {
  if (new Set(values).size !== values.length) {
    throw invalidPayload();
  }
}

export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidPayload();
  }
  return value as Record<string, unknown>;
}

export function invalidPayload() {
  return workflowError(
    'OPENSPEC_PAYLOAD_INVALID',
    'OpenSpec returned a payload that does not match the pinned operation contract.',
    ExitCode.unsafeEnvironment,
  );
}

function assertExistingFile(
  root: string,
  value: unknown,
  outputPath: string,
): string {
  if (typeof value !== 'string' || value !== path.resolve(value)) {
    throw invalidPayload();
  }
  assertInside(root, value);
  const stats = fs.lstatSync(value, { throwIfNoEntry: false });
  if (!stats?.isFile() || stats.isSymbolicLink()) {
    throw invalidPayload();
  }
  const canonicalValue = fs.realpathSync(value);
  assertInside(fs.realpathSync(root), canonicalValue);
  const relativePath = path.relative(root, value).split(path.sep).join('/');
  if (
    canonicalValue !== value ||
    !matchesArtifactOutput(relativePath, outputPath)
  ) {
    throw invalidPayload();
  }
  return value;
}

function matchesArtifactOutput(
  relativePath: string,
  outputPath: string,
): boolean {
  try {
    return path.matchesGlob(relativePath, outputPath);
  } catch {
    throw invalidPayload();
  }
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint <= 0x1f ||
      codePoint === 0x7f ||
      (codePoint >= 0x80 && codePoint <= 0x9f)
    );
  });
}

function assertInside(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw invalidPayload();
  }
}

function optionalPositiveInteger(value: unknown): boolean {
  return (
    value === undefined || (Number.isSafeInteger(value) && Number(value) > 0)
  );
}
