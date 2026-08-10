import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from './canonical-json.ts';
import { ExitCode, workflowError } from './errors.ts';
import {
  createEngineArtifact,
  type EngineArtifact,
  type Sha256Digest,
} from './intervention-control.ts';

const MAX_RECORD_BYTES = 4 * 1024 * 1024;

export interface StoredInterventionEngineArtifact {
  kind:
    | 'persisted-intervention-engine-artifact.v1'
    | 'persisted-intervention-engine-artifact.v2';
  parentChangeId: string;
  interventionChangeId: string;
  checkpointId: Sha256Digest;
  artifact: EngineArtifact;
  executablePath: string;
  workflowBindingDigest?: Sha256Digest;
  workflowStatus?: 'repair-active';
  createdAt: string;
  recordDigest: Sha256Digest;
}

export function interventionEngineArtifactRecordPath(
  storageRoot: string,
  artifactId: string,
): string {
  assertDigest(artifactId);
  if (
    typeof storageRoot !== 'string' ||
    !path.isAbsolute(storageRoot) ||
    path.resolve(storageRoot) !== storageRoot
  ) {
    throw artifactRecordCorrupt();
  }
  return path.join(
    storageRoot,
    'intervention-engine-artifacts',
    `${artifactId.slice('sha256:'.length)}.json`,
  );
}

export function readStoredInterventionEngineArtifact(
  storageRoot: string,
  artifactId: string,
): StoredInterventionEngineArtifact {
  const target = interventionEngineArtifactRecordPath(storageRoot, artifactId);
  const raw = readStablePrivateArtifactRecord(target);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw artifactRecordCorrupt();
  }
  if (
    !isRecord(value) ||
    `${canonicalJson(value)}\n` !== raw ||
    ![
      'persisted-intervention-engine-artifact.v1',
      'persisted-intervention-engine-artifact.v2',
    ].includes(String(value.kind))
  ) {
    throw artifactRecordCorrupt();
  }
  const v1Keys = [
    'artifact',
    'checkpointId',
    'createdAt',
    'executablePath',
    'interventionChangeId',
    'kind',
    'parentChangeId',
    'recordDigest',
  ];
  if (
    !hasExactKeys(
      value,
      value.kind === 'persisted-intervention-engine-artifact.v2'
        ? [...v1Keys, 'workflowBindingDigest', 'workflowStatus']
        : v1Keys,
    ) ||
    !verifyRecordDigest(value) ||
    !isNonEmptyTrimmed(value.parentChangeId) ||
    !isNonEmptyTrimmed(value.interventionChangeId) ||
    !isDigest(value.checkpointId) ||
    typeof value.executablePath !== 'string' ||
    !path.isAbsolute(value.executablePath) ||
    path.resolve(value.executablePath) !== value.executablePath ||
    !isCanonicalIso(value.createdAt) ||
    !isRecord(value.artifact)
  ) {
    throw artifactRecordCorrupt();
  }
  const artifact = createEngineArtifact(
    value.artifact as unknown as EngineArtifact,
  );
  if (
    artifact.artifactId !== artifactId ||
    artifact.artifactId !== value.artifact.artifactId ||
    (value.kind === 'persisted-intervention-engine-artifact.v2' &&
      (!isDigest(value.workflowBindingDigest) ||
        value.workflowStatus !== 'repair-active'))
  ) {
    throw artifactRecordCorrupt();
  }
  return deepFreeze({
    ...(value as unknown as StoredInterventionEngineArtifact),
    artifact,
  });
}

function readStablePrivateArtifactRecord(target: string): string {
  const directory = path.dirname(target);
  const directoryStats = fs.lstatSync(directory, {
    bigint: true,
    throwIfNoEntry: false,
  });
  if (directoryStats === undefined) throw artifactNotFound();
  if (
    !directoryStats.isDirectory() ||
    directoryStats.isSymbolicLink() ||
    (directoryStats.mode & 0o777n) !== 0o700n
  ) {
    throw artifactRecordCorrupt();
  }
  let realDirectory: string;
  try {
    realDirectory = fs.realpathSync(directory);
  } catch {
    throw artifactRecordCorrupt();
  }
  if (realDirectory !== directory) throw artifactRecordCorrupt();

  let descriptor: number;
  try {
    descriptor = fs.openSync(
      target,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw artifactNotFound();
    }
    throw artifactRecordCorrupt();
  }
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    assertStableArtifactFile(before);
    const raw = fs.readFileSync(descriptor, 'utf8');
    const after = fs.fstatSync(descriptor, { bigint: true });
    const current = fs.lstatSync(target, {
      bigint: true,
      throwIfNoEntry: false,
    });
    const currentDirectory = fs.lstatSync(directory, {
      bigint: true,
      throwIfNoEntry: false,
    });
    let currentRealDirectory: string | null = null;
    try {
      currentRealDirectory = fs.realpathSync(directory);
    } catch {
      // The identity comparison below fails closed.
    }
    if (
      current === undefined ||
      currentDirectory === undefined ||
      current.isSymbolicLink() ||
      currentRealDirectory !== directory ||
      !sameDirectoryIdentity(directoryStats, currentDirectory) ||
      !sameArtifactIdentity(before, after) ||
      !sameArtifactIdentity(before, current)
    ) {
      throw artifactRecordCorrupt();
    }
    return raw;
  } finally {
    fs.closeSync(descriptor);
  }
}

function sameDirectoryIdentity(
  expected: fs.BigIntStats,
  observed: fs.BigIntStats,
): boolean {
  return (
    expected.isDirectory() &&
    observed.isDirectory() &&
    !observed.isSymbolicLink() &&
    expected.dev === observed.dev &&
    expected.ino === observed.ino &&
    expected.mode === observed.mode
  );
}

function assertStableArtifactFile(stats: fs.BigIntStats): void {
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1n ||
    stats.size < 2n ||
    stats.size > BigInt(MAX_RECORD_BYTES) ||
    (stats.mode & 0o777n) !== 0o600n
  ) {
    throw artifactRecordCorrupt();
  }
}

function sameArtifactIdentity(
  expected: fs.BigIntStats,
  observed: fs.BigIntStats,
): boolean {
  return (
    expected.dev === observed.dev &&
    expected.ino === observed.ino &&
    expected.mode === observed.mode &&
    expected.nlink === observed.nlink &&
    expected.size === observed.size &&
    expected.mtimeNs === observed.mtimeNs &&
    expected.ctimeNs === observed.ctimeNs
  );
}

function verifyRecordDigest(value: Record<string, unknown>): boolean {
  if (!isDigest(value.recordDigest)) return false;
  const { recordDigest: _recordDigest, ...payload } = value;
  return digest(canonicalJson(payload)) === value.recordDigest;
}

function digest(value: string): Sha256Digest {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function assertDigest(value: unknown): asserts value is Sha256Digest {
  if (!isDigest(value)) {
    throw workflowError(
      'INTERVENTION_ENGINE_ARTIFACT_INVALID',
      'EngineArtifact id must be a canonical sha256 digest.',
      ExitCode.usage,
    );
  }
}

function isDigest(value: unknown): value is Sha256Digest {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

function isCanonicalIso(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function isNonEmptyTrimmed(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.trim() === value
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return (
    canonicalJson(Object.keys(value).sort()) ===
    canonicalJson([...expected].sort())
  );
}

function artifactRecordCorrupt() {
  return workflowError(
    'INTERVENTION_ENGINE_ARTIFACT_RECORD_CORRUPT',
    'Persisted intervention EngineArtifact failed integrity verification.',
    ExitCode.verification,
  );
}

function artifactNotFound() {
  return workflowError(
    'INTERVENTION_ENGINE_ARTIFACT_NOT_FOUND',
    'Persisted intervention EngineArtifact was not found.',
    ExitCode.conflict,
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
