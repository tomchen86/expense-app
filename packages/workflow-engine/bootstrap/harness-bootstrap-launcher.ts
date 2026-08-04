import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { HARNESS_BOOTSTRAP_RUNTIME_CLOSURE_MANIFEST_DIGEST } from './harness-bootstrap-runtime-closure-pin.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const MANIFEST_PATH = path.join(
  PACKAGE_ROOT,
  'bootstrap',
  'harness-bootstrap-dependency-closure.json',
);
const RUNTIME_ROOT = path.join(PACKAGE_ROOT, 'bootstrap', 'recovery-runtime');
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_RUNTIME_FILE_BYTES = 16 * 1024 * 1024;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

interface RuntimeClosureManifest {
  kind: 'harness-bootstrap-dependency-closure.v1';
  entrypoint: string;
  boundary: 'sealed-e1-independent-recovery-runtime';
  scope: 'compiled-transitive-runtime';
  claim: string;
  files: Array<{
    path: string;
    mode: '100644' | '100755';
    digest: `sha256:${string}`;
  }>;
}

try {
  const entrypoint = verifyRuntimeClosure();
  const result = childProcess.spawnSync(
    process.execPath,
    [entrypoint, ...process.argv.slice(2)],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
      windowsHide: true,
    },
  );
  if (result.error !== undefined) throw result.error;
  if (result.signal !== null) {
    process.kill(process.pid, result.signal);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
} catch (error) {
  const code =
    isRecord(error) && typeof error.code === 'string'
      ? error.code
      : 'HARNESS_BOOTSTRAP_LAUNCH_FAILED';
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `${JSON.stringify({
      kind: 'harness-bootstrap-launcher-error.v1',
      code,
      message,
    })}\n`,
  );
  process.exit(
    isRecord(error) &&
      Number.isSafeInteger(error.exitCode) &&
      Number(error.exitCode) > 0 &&
      Number(error.exitCode) <= 255
      ? Number(error.exitCode)
      : 1,
  );
}

function verifyRuntimeClosure(): string {
  assertPackageRoot();
  const manifestBytes = readExactFile(MANIFEST_PATH, 0o644, MAX_MANIFEST_BYTES);
  if (
    !DIGEST.test(HARNESS_BOOTSTRAP_RUNTIME_CLOSURE_MANIFEST_DIGEST) ||
    sha256(manifestBytes) !== HARNESS_BOOTSTRAP_RUNTIME_CLOSURE_MANIFEST_DIGEST
  ) {
    throw closureMismatch();
  }
  let value: unknown;
  try {
    value = JSON.parse(manifestBytes.toString('utf8')) as unknown;
  } catch {
    throw closureMismatch();
  }
  const manifest = assertManifest(value);
  const observedFiles = listRuntimeFiles(RUNTIME_ROOT).map((filePath) =>
    path.relative(PACKAGE_ROOT, filePath).split(path.sep).join('/'),
  );
  if (
    JSON.stringify(observedFiles) !==
    JSON.stringify(manifest.files.map((entry) => entry.path))
  ) {
    throw closureMismatch();
  }
  for (const entry of manifest.files) {
    const absolute = exactRuntimePath(entry.path);
    const expectedMode = entry.mode === '100755' ? 0o755 : 0o644;
    const bytes = readExactFile(absolute, expectedMode, MAX_RUNTIME_FILE_BYTES);
    if (sha256(bytes) !== entry.digest) throw closureMismatch();
  }
  if (!manifest.files.some((entry) => entry.path === manifest.entrypoint)) {
    throw closureMismatch();
  }
  return exactRuntimePath(manifest.entrypoint);
}

function assertManifest(value: unknown): RuntimeClosureManifest {
  if (
    !isRecord(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify(
        ['boundary', 'claim', 'entrypoint', 'files', 'kind', 'scope'].sort(),
      ) ||
    value.kind !== 'harness-bootstrap-dependency-closure.v1' ||
    value.boundary !== 'sealed-e1-independent-recovery-runtime' ||
    value.scope !== 'compiled-transitive-runtime' ||
    typeof value.claim !== 'string' ||
    value.claim.length < 16 ||
    typeof value.entrypoint !== 'string' ||
    !Array.isArray(value.files) ||
    value.files.length === 0
  ) {
    throw closureMismatch();
  }
  const files = value.files.map((raw) => {
    if (
      !isRecord(raw) ||
      JSON.stringify(Object.keys(raw).sort()) !==
        JSON.stringify(['digest', 'mode', 'path']) ||
      typeof raw.path !== 'string' ||
      !raw.path.startsWith('bootstrap/recovery-runtime/') ||
      raw.path.includes('\\') ||
      path.posix.normalize(raw.path) !== raw.path ||
      !['100644', '100755'].includes(String(raw.mode)) ||
      typeof raw.digest !== 'string' ||
      !DIGEST.test(raw.digest)
    ) {
      throw closureMismatch();
    }
    return {
      path: raw.path,
      mode: raw.mode as '100644' | '100755',
      digest: raw.digest as `sha256:${string}`,
    };
  });
  if (
    JSON.stringify(files.map(({ path: filePath }) => filePath)) !==
      JSON.stringify(
        files
          .map(({ path: filePath }) => filePath)
          .sort((left, right) => left.localeCompare(right)),
      ) ||
    new Set(files.map(({ path: filePath }) => filePath)).size !== files.length
  ) {
    throw closureMismatch();
  }
  return {
    kind: value.kind,
    entrypoint: value.entrypoint,
    boundary: value.boundary,
    scope: value.scope,
    claim: value.claim,
    files,
  };
}

function assertPackageRoot(): void {
  const stats = fs.lstatSync(PACKAGE_ROOT, { throwIfNoEntry: false });
  if (!stats?.isDirectory() || stats.isSymbolicLink()) throw closureMismatch();
}

function exactRuntimePath(relativePath: string): string {
  const absolute = path.resolve(PACKAGE_ROOT, relativePath);
  if (
    absolute !== RUNTIME_ROOT &&
    !absolute.startsWith(`${RUNTIME_ROOT}${path.sep}`)
  ) {
    throw closureMismatch();
  }
  return absolute;
}

function listRuntimeFiles(directory: string): string[] {
  const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stats?.isDirectory() || stats.isSymbolicLink()) throw closureMismatch();
  const files: string[] = [];
  const visit = (current: string): void => {
    for (const name of fs.readdirSync(current).sort()) {
      const candidate = path.join(current, name);
      const child = fs.lstatSync(candidate);
      if (child.isSymbolicLink()) throw closureMismatch();
      if (child.isDirectory()) {
        visit(candidate);
      } else if (child.isFile()) {
        files.push(candidate);
      } else {
        throw closureMismatch();
      }
    }
  };
  visit(directory);
  return files.sort((left, right) => left.localeCompare(right));
}

function readExactFile(
  filePath: string,
  expectedMode: number,
  maxBytes: number,
): Buffer {
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (
    !stats?.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    stats.size > maxBytes ||
    (stats.mode & 0o777) !== expectedMode
  ) {
    throw closureMismatch();
  }
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const opened = fs.fstatSync(descriptor);
    if (
      opened.dev !== stats.dev ||
      opened.ino !== stats.ino ||
      opened.size !== stats.size ||
      opened.nlink !== 1
    ) {
      throw closureMismatch();
    }
    return fs.readFileSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function sha256(value: string | Buffer): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function closureMismatch(): Error & { code: string; exitCode: number } {
  return Object.assign(
    new Error(
      'Sealed harness-bootstrap runtime is missing, stale, indirect, or has changed bytes.',
    ),
    {
      code: 'HARNESS_BOOTSTRAP_RUNTIME_CLOSURE_MISMATCH',
      exitCode: 13,
    },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
