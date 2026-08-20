import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import { parseCheckCommand } from '@jigwright/core/check-command';
import type {
  CheckRegistryV1,
  CheckRegistryPortV1,
} from '@jigwright/core/check-registry-port';
import {
  RepositoryPathError,
  normalizeExactRepositoryPath,
} from '@jigwright/core/repository-path';

const FIXTURE_CHECK_SOURCE = 'tooling/fixture-checks.json';
const MAX_FIXTURE_CHECK_SOURCE_BYTES = 128 * 1024;
const MAX_SCRIPT_BYTES = 1_024;
const CHECK_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const WINDOWS_DRIVE_RELATIVE_PATTERN = /^[a-zA-Z]:/;

type FixtureCheckSource = {
  kind: 'jigwright.fixture-checks.v1';
  checks: Record<string, { script: string }>;
};

export function loadFixtureCheckRegistry(
  repositoryRoot: string,
): CheckRegistryV1 {
  const source = readFixtureCheckSource(repositoryRoot);
  const checks: CheckRegistryV1['checks'] = {};
  for (const [checkId, definition] of Object.entries(source.checks)) {
    const command = ['node', definition.script];
    if (parseCheckCommand(command) === undefined) {
      throw new Error(
        'Fixture check source cannot be represented by the core check contract.',
      );
    }
    checks[checkId] = {
      command,
      destructiveDatabase: false,
    };
  }
  return {
    schemaVersion: 1,
    checks,
  };
}

export const fixtureCheckRegistryPort: CheckRegistryPortV1 = {
  contractVersion: 'jigwright.check-registry-port.v1',
  load: loadFixtureCheckRegistry,
};

function readFixtureCheckSource(repositoryRoot: string): FixtureCheckSource {
  const resolvedRoot = path.resolve(repositoryRoot);
  const canonicalRoot = fs.realpathSync.native(resolvedRoot);
  const sourcePath = path.join(resolvedRoot, FIXTURE_CHECK_SOURCE);
  const canonicalSource = fs.realpathSync.native(sourcePath);
  if (
    canonicalSource !== path.join(canonicalRoot, FIXTURE_CHECK_SOURCE) ||
    !isInside(canonicalRoot, canonicalSource)
  ) {
    throw new Error('Fixture check source must be a repository regular file.');
  }

  const before = fs.lstatSync(sourcePath, { bigint: true });
  assertSafeSourceStats(before);
  if (
    before.size === 0n ||
    before.size > BigInt(MAX_FIXTURE_CHECK_SOURCE_BYTES)
  ) {
    throw new Error('Fixture check source must be a bounded non-empty file.');
  }

  const noFollowFlag =
    process.platform !== 'win32' && typeof fs.constants.O_NOFOLLOW === 'number'
      ? fs.constants.O_NOFOLLOW
      : 0;
  const descriptor = fs.openSync(
    sourcePath,
    fs.constants.O_RDONLY | noFollowFlag,
  );
  let bytes: Buffer;
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    assertSafeSourceStats(opened);
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.mode !== before.mode
    ) {
      throw new Error('Fixture check source changed while it was opened.');
    }
    bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    assertSafeSourceStats(after);
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mode !== opened.mode ||
      bytes.byteLength !== Number(opened.size)
    ) {
      throw new Error('Fixture check source changed while it was read.');
    }
  } finally {
    fs.closeSync(descriptor);
  }

  let document: string;
  try {
    document = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Fixture check source must be valid UTF-8.');
  }

  let value: unknown;
  try {
    value = JSON.parse(document) as unknown;
  } catch {
    throw new Error('Fixture check source must use the exact schema.');
  }
  return parseFixtureCheckSource(value);
}

function parseFixtureCheckSource(value: unknown): FixtureCheckSource {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['kind', 'checks']) ||
    value.kind !== 'jigwright.fixture-checks.v1' ||
    !isRecord(value.checks)
  ) {
    throw new Error('Fixture check source must use the exact schema.');
  }

  for (const [checkId, definition] of Object.entries(value.checks)) {
    if (
      !CHECK_ID_PATTERN.test(checkId) ||
      !isRecord(definition) ||
      !hasExactKeys(definition, ['script']) ||
      !isSafeRelativeScript(definition.script)
    ) {
      throw new Error(
        typeof definition === 'object' && definition !== null
          ? 'Fixture check definitions must use the exact schema and a safe relative script.'
          : 'Fixture check source must use the exact schema.',
      );
    }
  }

  return value as FixtureCheckSource;
}

function isSafeRelativeScript(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > MAX_SCRIPT_BYTES ||
    value.startsWith('-') ||
    value.trim() !== value ||
    value.normalize('NFC') !== value ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    WINDOWS_DRIVE_RELATIVE_PATTERN.test(value) ||
    value.includes('\\') ||
    path.posix.normalize(value) !== value
  ) {
    return false;
  }
  try {
    return normalizeExactRepositoryPath(value) === value;
  } catch (error) {
    if (error instanceof RepositoryPathError) return false;
    throw error;
  }
}

function assertSafeSourceStats(stats: fs.BigIntStats): void {
  if (!stats.isFile()) {
    throw new Error('Fixture check source must be a regular file.');
  }
  if (stats.nlink !== 1n) {
    throw new Error('Fixture check source must be a single-link regular file.');
  }
  if ((stats.mode & 0o111n) !== 0n) {
    throw new Error('Fixture check source must be non-executable.');
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === keys.length &&
    actual.every((key, index) => key === [...keys].sort()[index])
  );
}
