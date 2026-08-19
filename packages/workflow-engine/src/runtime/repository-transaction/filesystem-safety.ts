import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NO_FOLLOW_CREATE =
  fs.constants.O_RDWR |
  fs.constants.O_CREAT |
  fs.constants.O_EXCL |
  fs.constants.O_NOFOLLOW;

export type PreparedLockOwner = Readonly<{
  pid: number;
  ownerToken: string;
}>;

export type PreparedLockReclaimResult =
  'absent' | 'occupied' | 'reclaimed' | 'unsafe';

export function ensurePlainDirectory(directory: string): void {
  const absolute = path.resolve(directory);
  const existing = fs.lstatSync(absolute, { throwIfNoEntry: false });
  if (!existing) {
    const parent = path.dirname(absolute);
    if (parent === absolute) {
      throw unsafeDirectory(absolute);
    }
    ensurePlainDirectory(parent);
    try {
      fs.mkdirSync(absolute, { mode: 0o700 });
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'EEXIST') {
        throw error;
      }
    }
  }
  assertPlainDirectory(absolute);
}

export function assertPlainDirectory(directory: string): void {
  const absolute = path.resolve(directory);
  const stats = fs.lstatSync(absolute, { throwIfNoEntry: false });
  if (
    !stats?.isDirectory() ||
    stats.isSymbolicLink() ||
    fs.realpathSync(absolute) !== absolute
  ) {
    throw unsafeDirectory(absolute);
  }
}

export function preparedLockTemporaryPath(
  lockPath: string,
  pid: number,
  ownerToken: string,
): string {
  if (!validPreparedLockOwner({ pid, ownerToken })) {
    throw new Error('Prepared lock owner identity is invalid.');
  }
  return `${lockPath}.${pid}.${ownerToken}.tmp`;
}

export function publishPreparedExclusiveLock(
  lockPath: string,
  content: string,
  ownerToken: string,
  makeUnsafeError: () => Error = () =>
    new Error('Prepared lock publication is unsafe.'),
): number {
  const temporaryPath = preparedLockTemporaryPath(
    lockPath,
    process.pid,
    ownerToken,
  );
  let descriptor: number | undefined;
  let published = false;
  try {
    descriptor = fs.openSync(temporaryPath, NO_FOLLOW_CREATE, 0o600);
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    const reclaimState = clearDeadPreparedLockReclaimClaims(lockPath);
    if (reclaimState === 'live') {
      throw exclusiveConflict();
    }
    if (reclaimState === 'unsafe') {
      throw makeUnsafeError();
    }
    fs.linkSync(temporaryPath, lockPath);
    published = true;
    // A reclaimer can claim and unlink the prior owner after our first scan
    // but before this link. Do not enter the protected operation while any
    // reclaimer that could still unlink this pathname remains active.
    const postLinkReclaimState = clearDeadPreparedLockReclaimClaims(lockPath);
    if (postLinkReclaimState === 'live') {
      throw exclusiveConflict();
    }
    if (postLinkReclaimState === 'unsafe') {
      throw makeUnsafeError();
    }
    fsyncDirectory(path.dirname(lockPath));
    fs.unlinkSync(temporaryPath);
    fsyncDirectory(path.dirname(lockPath));
    const owned = fs.fstatSync(descriptor);
    const observed = fs.lstatSync(lockPath, { throwIfNoEntry: false });
    if (
      !observed?.isFile() ||
      observed.isSymbolicLink() ||
      observed.dev !== owned.dev ||
      observed.ino !== owned.ino ||
      owned.nlink !== 1 ||
      (owned.mode & 0o777) !== 0o600 ||
      readDescriptorContent(descriptor, Buffer.byteLength(content)) !== content
    ) {
      throw makeUnsafeError();
    }
    return descriptor;
  } catch (error) {
    let cleanupError: unknown;
    let cleanupClaimPath: string | undefined;
    if (descriptor !== undefined && published) {
      try {
        cleanupClaimPath = createPreparedLockReclaimClaim(lockPath);
        const owned = fs.fstatSync(descriptor);
        const observed = fs.lstatSync(lockPath, { throwIfNoEntry: false });
        if (
          observed?.isFile() &&
          !observed.isSymbolicLink() &&
          observed.dev === owned.dev &&
          observed.ino === owned.ino
        ) {
          try {
            fs.unlinkSync(lockPath);
          } catch (unlinkError) {
            if (!isNodeError(unlinkError) || unlinkError.code !== 'ENOENT') {
              throw unlinkError;
            }
          }
        }
      } catch (cleanupFailure) {
        cleanupError = cleanupFailure;
      }
    }
    try {
      if (descriptor !== undefined) {
        fs.closeSync(descriptor);
      }
    } catch (cleanupFailure) {
      cleanupError ??= cleanupFailure;
    }
    try {
      fs.rmSync(temporaryPath, { force: true });
      fsyncDirectory(path.dirname(lockPath));
    } catch (cleanupFailure) {
      cleanupError ??= cleanupFailure;
    }
    if (cleanupClaimPath !== undefined) {
      try {
        removePreparedLockReclaimClaim(cleanupClaimPath);
      } catch (cleanupFailure) {
        cleanupError ??= cleanupFailure;
      }
    }
    if (cleanupError !== undefined) {
      throw cleanupError;
    }
    throw error;
  }
}

export function reclaimDeadPreparedLock(
  lockPath: string,
  readOwner: (content: string) => PreparedLockOwner | null,
): PreparedLockReclaimResult {
  const before = fs.lstatSync(lockPath, { throwIfNoEntry: false });
  if (!before) {
    return 'absent';
  }
  if (!validPreparedLockStats(before)) {
    return 'unsafe';
  }
  let descriptor: number | undefined;
  let claimPath: string | undefined;
  try {
    descriptor = fs.openSync(
      lockPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const opened = fs.fstatSync(descriptor);
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      !validPreparedLockStats(opened)
    ) {
      return 'unsafe';
    }
    const content = fs.readFileSync(descriptor, 'utf8');
    const owner = readOwner(content);
    if (!owner || !validPreparedLockOwner(owner)) {
      return 'unsafe';
    }
    if (isProcessAlive(owner.pid)) {
      return 'occupied';
    }
    const temporaryPath =
      opened.nlink === 2
        ? preparedLockTemporaryPath(lockPath, owner.pid, owner.ownerToken)
        : null;
    if (
      temporaryPath !== null &&
      !isExactPreparedLockAlias(temporaryPath, opened)
    ) {
      return 'unsafe';
    }
    const reclaimState = clearDeadPreparedLockReclaimClaims(lockPath);
    if (reclaimState === 'live') {
      return 'occupied';
    }
    if (reclaimState === 'unsafe') {
      return 'unsafe';
    }
    claimPath = createPreparedLockReclaimClaim(lockPath);
    const observed = fs.lstatSync(lockPath, { throwIfNoEntry: false });
    if (
      !observed ||
      observed.dev !== opened.dev ||
      observed.ino !== opened.ino
    ) {
      return 'reclaimed';
    }
    if (temporaryPath !== null) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch (error) {
        if (!isNodeError(error) || error.code !== 'ENOENT') {
          throw error;
        }
      }
    }
    const final = fs.lstatSync(lockPath, { throwIfNoEntry: false });
    if (!final || final.dev !== opened.dev || final.ino !== opened.ino) {
      return 'reclaimed';
    }
    try {
      fs.unlinkSync(lockPath);
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') {
        throw error;
      }
    }
    fsyncDirectory(path.dirname(lockPath));
    return 'reclaimed';
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    if (claimPath !== undefined) {
      removePreparedLockReclaimClaim(claimPath);
    }
  }
}

export function withPreparedLockCleanupClaim<T>(
  lockPath: string,
  operation: () => T,
): T {
  const claimPath = createPreparedLockReclaimClaim(lockPath);
  try {
    return operation();
  } finally {
    removePreparedLockReclaimClaim(claimPath);
  }
}

function createPreparedLockReclaimClaim(lockPath: string): string {
  const claimPath = preparedLockReclaimClaimPath(
    lockPath,
    process.pid,
    crypto.randomUUID(),
  );
  fs.mkdirSync(claimPath, { mode: 0o700 });
  fs.chmodSync(claimPath, 0o700);
  fsyncDirectory(path.dirname(lockPath));
  return claimPath;
}

function removePreparedLockReclaimClaim(claimPath: string): void {
  const claim = fs.lstatSync(claimPath, { throwIfNoEntry: false });
  if (!claim) {
    return;
  }
  if (
    !claim.isDirectory() ||
    claim.isSymbolicLink() ||
    (claim.mode & 0o777) !== 0o700 ||
    fs.readdirSync(claimPath).length !== 0
  ) {
    throw new Error('Prepared lock reclaim claim is unsafe.');
  }
  try {
    fs.rmdirSync(claimPath);
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') {
      throw error;
    }
  }
  fsyncDirectory(path.dirname(claimPath));
}

function clearDeadPreparedLockReclaimClaims(
  lockPath: string,
): 'clear' | 'live' | 'unsafe' {
  const directory = path.dirname(lockPath);
  const prefix = `${path.basename(lockPath)}.reclaim.`;
  let removed = false;
  let live = false;
  for (const name of fs.readdirSync(directory)) {
    if (!name.startsWith(prefix)) {
      continue;
    }
    const match =
      /^(.+)\.reclaim\.([1-9][0-9]*)\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(
        name,
      );
    if (
      !match ||
      match[1] !== path.basename(lockPath) ||
      !match[2] ||
      !match[3]
    ) {
      return 'unsafe';
    }
    const claimPath = path.join(directory, name);
    const stats = fs.lstatSync(claimPath, { throwIfNoEntry: false });
    if (!stats) {
      continue;
    }
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      (stats.mode & 0o777) !== 0o700 ||
      fs.readdirSync(claimPath).length !== 0
    ) {
      return 'unsafe';
    }
    const pid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || pid < 1) {
      return 'unsafe';
    }
    if (isProcessAlive(pid)) {
      live = true;
      continue;
    }
    try {
      fs.rmdirSync(claimPath);
      removed = true;
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') {
        throw error;
      }
    }
  }
  if (removed) {
    fsyncDirectory(directory);
  }
  return live ? 'live' : 'clear';
}

function preparedLockReclaimClaimPath(
  lockPath: string,
  pid: number,
  ownerToken: string,
): string {
  if (!validPreparedLockOwner({ pid, ownerToken })) {
    throw new Error('Prepared lock reclaimer identity is invalid.');
  }
  return `${lockPath}.reclaim.${pid}.${ownerToken}`;
}

function validPreparedLockOwner(owner: PreparedLockOwner): boolean {
  return (
    Number.isSafeInteger(owner.pid) &&
    owner.pid >= 1 &&
    UUID_V4.test(owner.ownerToken)
  );
}

function validPreparedLockStats(stats: fs.Stats): boolean {
  return (
    stats.isFile() &&
    !stats.isSymbolicLink() &&
    [1, 2].includes(stats.nlink) &&
    (stats.mode & 0o777) === 0o600
  );
}

function isExactPreparedLockAlias(
  temporaryPath: string,
  owned: fs.Stats,
): boolean {
  const temporary = fs.lstatSync(temporaryPath, { throwIfNoEntry: false });
  return (
    temporary?.isFile() === true &&
    !temporary.isSymbolicLink() &&
    temporary.dev === owned.dev &&
    temporary.ino === owned.ino &&
    temporary.nlink === 2 &&
    (temporary.mode & 0o777) === 0o600
  );
}

function readDescriptorContent(descriptor: number, byteLength: number): string {
  const bytes = Buffer.alloc(byteLength);
  const count = fs.readSync(descriptor, bytes, 0, byteLength, 0);
  return bytes.subarray(0, count).toString('utf8');
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(isNodeError(error) && error.code === 'ESRCH');
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

function exclusiveConflict(): NodeJS.ErrnoException {
  return Object.assign(new Error('Prepared lock is occupied.'), {
    code: 'EEXIST',
  });
}

function unsafeDirectory(directory: string) {
  return workflowError(
    'RUNTIME_DIRECTORY_UNSAFE',
    'Workflow runtime directory is not a canonical plain directory.',
    ExitCode.staleState,
    { details: { directory } },
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
