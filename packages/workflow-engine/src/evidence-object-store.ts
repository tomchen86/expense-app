import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from './canonical-json.ts';
import { ExitCode, workflowError } from './errors.ts';
import {
  assertStoredEvidenceNode,
  canonicalEvidenceNodeEnvelope,
  type EvidenceNode,
} from './evidence-node.ts';
import { assertChangeId, type InvestigationRuntimePaths } from './paths.ts';

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const REF_NAME_PATTERN =
  /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;

const NO_FOLLOW_CREATE =
  fs.constants.O_RDWR |
  fs.constants.O_CREAT |
  fs.constants.O_EXCL |
  fs.constants.O_NOFOLLOW;

export type CompareAndSwapEvidenceRefParams = {
  changeId: string;
  refName: string;
  expectedNodeId: string | null;
  nextNodeId: string;
};

export function writeEvidenceNode(
  paths: InvestigationRuntimePaths,
  node: EvidenceNode,
): string {
  assertStoredEvidenceNode(node, objectInvalid);
  const content = canonicalEvidenceNodeEnvelope(node);
  const objectPath = evidenceObjectPath(paths, node.nodeId);
  ensureNoFollowDirectory(
    paths.base,
    paths.root,
    path.dirname(objectPath),
    objectUnsafe,
  );

  let descriptor: number | undefined;
  let created = false;
  try {
    descriptor = fs.openSync(objectPath, NO_FOLLOW_CREATE, 0o600);
    created = true;
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fsyncDirectory(path.dirname(objectPath));
  } catch (error) {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    if (isNodeError(error) && error.code === 'EEXIST') {
      if (readNoFollow(objectPath, objectUnsafe) === content) {
        return node.nodeId;
      }
      throw objectCollision(node.nodeId);
    }
    if (created) {
      fs.rmSync(objectPath, { force: true });
    }
    throw error;
  }
  return node.nodeId;
}

export function readEvidenceNode(
  paths: InvestigationRuntimePaths,
  nodeId: string,
): EvidenceNode {
  assertNodeId(nodeId);
  const objectPath = evidenceObjectPath(paths, nodeId);
  assertNoFollowDirectory(
    paths.base,
    paths.root,
    path.dirname(objectPath),
    objectUnsafe,
  );
  const content = readNoFollow(objectPath, objectUnsafe);
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw objectInvalid();
  }
  const node = assertStoredEvidenceNode(parsed, objectInvalid);
  if (
    node.nodeId !== nodeId ||
    content !== canonicalEvidenceNodeEnvelope(node)
  ) {
    throw objectInvalid();
  }
  return node;
}

export function readEvidenceRefs(
  paths: InvestigationRuntimePaths,
  changeId: string,
): Record<string, string> {
  assertChangeId(changeId);
  const refPath = evidenceRefPath(paths, changeId);
  if (!assertNoFollowDirectory(paths.base, paths.root, paths.refs, refUnsafe)) {
    return {};
  }
  const stats = fs.lstatSync(refPath, { throwIfNoEntry: false });
  if (!stats) {
    return {};
  }
  const content = readNoFollow(refPath, refUnsafe);
  return parseRefDocument(content, changeId);
}

export function compareAndSwapEvidenceRef(
  paths: InvestigationRuntimePaths,
  params: CompareAndSwapEvidenceRefParams,
): void {
  assertChangeId(params.changeId);
  assertRefName(params.refName);
  assertNodeId(params.nextNodeId);
  if (
    params.expectedNodeId !== null &&
    !DIGEST_PATTERN.test(params.expectedNodeId)
  ) {
    throw refInvalid();
  }
  const nextObjectPath = evidenceObjectPath(paths, params.nextNodeId);
  const nextDirectoryExists = assertNoFollowDirectory(
    paths.base,
    paths.root,
    path.dirname(nextObjectPath),
    objectUnsafe,
  );
  if (
    !nextDirectoryExists ||
    !fs.lstatSync(nextObjectPath, { throwIfNoEntry: false })
  ) {
    throw objectUnavailable(params.nextNodeId);
  }
  readEvidenceNode(paths, params.nextNodeId);

  withRefLock(paths, params.changeId, () => {
    const current = readEvidenceRefs(paths, params.changeId);
    const observed = current[params.refName] ?? null;
    if (observed !== (params.expectedNodeId ?? null)) {
      throw refCasMismatch(params.refName, params.expectedNodeId, observed);
    }
    const next = { ...current, [params.refName]: params.nextNodeId };
    writeRefDocument(paths, params.changeId, next);
  });
}

function parseRefDocument(
  content: string,
  changeId: string,
): Record<string, string> {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw refInvalid();
  }
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ['schemaVersion', 'changeId', 'refs']) ||
    value.schemaVersion !== 1 ||
    value.changeId !== changeId ||
    !isPlainRecord(value.refs)
  ) {
    throw refInvalid();
  }
  const refs = value.refs as Record<string, unknown>;
  for (const [name, digest] of Object.entries(refs)) {
    if (!REF_NAME_PATTERN.test(name) || !isDigest(digest)) {
      throw refInvalid();
    }
  }
  if (content !== canonicalJson(value)) {
    throw refInvalid();
  }
  return refs as Record<string, string>;
}

function writeRefDocument(
  paths: InvestigationRuntimePaths,
  changeId: string,
  refs: Record<string, string>,
): void {
  const refPath = evidenceRefPath(paths, changeId);
  const content = canonicalJson({ schemaVersion: 1, changeId, refs });
  ensureNoFollowDirectory(paths.base, paths.root, paths.refs, refUnsafe);
  const existing = fs.lstatSync(refPath, { throwIfNoEntry: false });
  if (existing) {
    assertPrivateFileStats(existing, refUnsafe);
  }
  const temporary = `${refPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, NO_FOLLOW_CREATE, 0o600);
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    ensureNoFollowDirectory(paths.base, paths.root, paths.refs, refUnsafe);
    const current = fs.lstatSync(refPath, { throwIfNoEntry: false });
    if (current) {
      assertPrivateFileStats(current, refUnsafe);
    }
    fs.renameSync(temporary, refPath);
    fsyncDirectory(paths.refs);
  } catch (error) {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function withRefLock<T>(
  paths: InvestigationRuntimePaths,
  changeId: string,
  operation: () => T,
): T {
  ensureNoFollowDirectory(paths.base, paths.root, paths.refs, refUnsafe);
  const lockPath = path.join(paths.refs, `${changeId}.lock`);
  const marker = `${process.pid}:${crypto.randomUUID()}\n`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(lockPath, NO_FOLLOW_CREATE, 0o600);
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, marker, 'utf8');
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    if (isNodeError(error) && error.code === 'EEXIST') {
      throw refLocked(changeId);
    }
    throw error;
  }
  const owned = fs.fstatSync(descriptor);
  try {
    return operation();
  } finally {
    releaseRefLock(lockPath, descriptor, owned, marker);
  }
}

function releaseRefLock(
  lockPath: string,
  descriptor: number,
  owned: fs.Stats,
  marker: string,
): void {
  const stats = fs.lstatSync(lockPath, { throwIfNoEntry: false });
  let observed: string | undefined;
  try {
    const bytes = Buffer.alloc(Buffer.byteLength(marker));
    const count = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
    observed = bytes.subarray(0, count).toString('utf8');
  } catch {
    observed = undefined;
  }
  fs.closeSync(descriptor);
  // Only remove a lock that is still the exact file we created; ownership that
  // changed under us must not be unlinked.
  if (
    stats?.isFile() &&
    !stats.isSymbolicLink() &&
    stats.dev === owned.dev &&
    stats.ino === owned.ino &&
    observed === marker
  ) {
    fs.unlinkSync(lockPath);
    fsyncDirectory(path.dirname(lockPath));
    return;
  }
  throw refLockInvalid();
}

function ensureNoFollowDirectory(
  base: string,
  privateRoot: string,
  directory: string,
  makeError: () => ReturnType<typeof workflowError>,
): void {
  walkNoFollowDirectory(base, privateRoot, directory, makeError, true);
}

function assertNoFollowDirectory(
  base: string,
  privateRoot: string,
  directory: string,
  makeError: () => ReturnType<typeof workflowError>,
): boolean {
  return walkNoFollowDirectory(base, privateRoot, directory, makeError, false);
}

function walkNoFollowDirectory(
  base: string,
  privateRoot: string,
  directory: string,
  makeError: () => ReturnType<typeof workflowError>,
  create: boolean,
): boolean {
  const relative = path.relative(base, directory);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw makeError();
  }
  let current = base;
  for (const segment of relative.split(path.sep)) {
    if (!segment) {
      continue;
    }
    current = path.join(current, segment);
    let stats = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stats) {
      if (!create) {
        return false;
      }
      fs.mkdirSync(current, { mode: 0o700 });
      fs.chmodSync(current, 0o700);
      stats = fs.lstatSync(current);
      fsyncDirectory(path.dirname(current));
    }
    if (
      stats.isSymbolicLink() ||
      !stats.isDirectory() ||
      fs.realpathSync(current) !== path.resolve(current)
    ) {
      throw makeError();
    }
    if (
      isInsideOrEqual(privateRoot, current) &&
      (stats.mode & 0o777) !== 0o700
    ) {
      throw makeError();
    }
  }
  return true;
}

function isInsideOrEqual(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function evidenceObjectPath(
  paths: InvestigationRuntimePaths,
  nodeId: string,
): string {
  return path.join(paths.objects, nodeId.slice(0, 2), `${nodeId}.json`);
}

function evidenceRefPath(
  paths: InvestigationRuntimePaths,
  changeId: string,
): string {
  return path.join(paths.refs, `${changeId}.json`);
}

function readNoFollow(
  filePath: string,
  makeError: () => ReturnType<typeof workflowError>,
): string {
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!stats) {
    throw makeError();
  }
  assertPrivateFileStats(stats, makeError);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
  } catch {
    throw makeError();
  }
  try {
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      (opened.mode & 0o777) !== 0o600 ||
      opened.dev !== stats.dev ||
      opened.ino !== stats.ino
    ) {
      throw makeError();
    }
    return fs.readFileSync(descriptor, 'utf8');
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertPrivateFileStats(
  stats: fs.Stats,
  makeError: () => ReturnType<typeof workflowError>,
): void {
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (stats.mode & 0o777) !== 0o600
  ) {
    throw makeError();
  }
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertNodeId(nodeId: string): void {
  if (!DIGEST_PATTERN.test(nodeId)) {
    throw workflowError(
      'EVIDENCE_OBJECT_ID_INVALID',
      `Invalid evidence node identifier: ${nodeId}`,
      ExitCode.usage,
    );
  }
}

function assertRefName(refName: string): void {
  if (typeof refName !== 'string' || !REF_NAME_PATTERN.test(refName)) {
    throw workflowError(
      'EVIDENCE_REF_NAME_INVALID',
      `Invalid evidence ref name: ${refName}`,
      ExitCode.usage,
    );
  }
}

function objectUnsafe() {
  return workflowError(
    'EVIDENCE_OBJECT_UNSAFE',
    'Evidence object path is not a canonical no-follow location.',
    ExitCode.unsafeEnvironment,
  );
}

function objectInvalid() {
  return workflowError(
    'EVIDENCE_OBJECT_INVALID',
    'Evidence object envelope is forged, tampered, or noncanonical.',
    ExitCode.staleState,
  );
}

function objectCollision(nodeId: string) {
  return workflowError(
    'EVIDENCE_OBJECT_COLLISION',
    'A different evidence envelope already exists for this node identifier.',
    ExitCode.conflict,
    { details: { nodeId } },
  );
}

function objectUnavailable(nodeId: string) {
  return workflowError(
    'EVIDENCE_OBJECT_UNAVAILABLE',
    'The next evidence node must already exist as a stored object.',
    ExitCode.staleState,
    { details: { nodeId } },
  );
}

function refUnsafe() {
  return workflowError(
    'EVIDENCE_REF_UNSAFE',
    'Evidence ref path is not a canonical no-follow location.',
    ExitCode.unsafeEnvironment,
  );
}

function refInvalid() {
  return workflowError(
    'EVIDENCE_REF_INVALID',
    'Evidence ref document is malformed or noncanonical.',
    ExitCode.staleState,
  );
}

function refCasMismatch(
  refName: string,
  expectedNodeId: string | null,
  observedNodeId: string | null,
) {
  return workflowError(
    'EVIDENCE_REF_CAS_MISMATCH',
    'Evidence ref changed during compare-and-swap.',
    ExitCode.conflict,
    { details: { refName, expectedNodeId, observedNodeId } },
  );
}

function refLocked(changeId: string) {
  return workflowError(
    'EVIDENCE_REF_LOCKED',
    'Evidence ref for this change is locked by another operation.',
    ExitCode.conflict,
    { details: { changeId } },
  );
}

function refLockInvalid() {
  return workflowError(
    'EVIDENCE_REF_LOCK_INVALID',
    'Evidence ref lock ownership changed during the operation.',
    ExitCode.staleState,
  );
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST_PATTERN.test(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const own = Object.keys(value);
  return (
    own.length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
