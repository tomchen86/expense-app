import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const REPOSITORY_ROOT = path.resolve(PACKAGE_ROOT, '../..');
const RUNTIME_ROOT = path.join(import.meta.dirname, 'recovery-runtime');
const MANIFEST_PATH = path.join(
  import.meta.dirname,
  'harness-bootstrap-dependency-closure.json',
);
const PIN_PATH = path.join(
  import.meta.dirname,
  'harness-bootstrap-runtime-closure-pin.ts',
);
const ENTRYPOINT = 'bootstrap/recovery-runtime/src/harness-bootstrap.js';
const mode = process.argv[2];

if (!['--write', '--check'].includes(mode ?? '')) {
  process.stderr.write(
    'Usage: generate-harness-bootstrap-runtime.ts <--write|--check>\n',
  );
  process.exit(2);
}

const staging = path.join(
  import.meta.dirname,
  `.recovery-runtime.${process.pid}.${crypto.randomUUID()}.tmp`,
);

try {
  compileRuntime(staging);
  const files = listFiles(staging).map((absolute) => {
    const relativeToStaging = path.relative(staging, absolute);
    const runtimePath = path.posix.join(
      'bootstrap/recovery-runtime',
      relativeToStaging.split(path.sep).join('/'),
    );
    const executable = runtimePath === ENTRYPOINT;
    fs.chmodSync(absolute, executable ? 0o755 : 0o644);
    return {
      path: runtimePath,
      mode: executable ? ('100755' as const) : ('100644' as const),
      digest: sha256(fs.readFileSync(absolute)),
    };
  });
  const manifest = {
    kind: 'harness-bootstrap-dependency-closure.v1',
    entrypoint: ENTRYPOINT,
    boundary: 'sealed-e1-independent-recovery-runtime',
    scope: 'compiled-transitive-runtime',
    claim:
      'This sealed compiled recovery runtime is independent of the mutable E1 src tree and remains usable when E1 cannot load.',
    files,
  } as const;
  if (!files.some(({ path: filePath }) => filePath === ENTRYPOINT)) {
    throw new Error('Compiled harness-bootstrap entrypoint is missing.');
  }
  if (
    files.some(
      ({ path: filePath }) =>
        filePath === 'bootstrap/recovery-runtime/src/cli.js',
    )
  ) {
    throw new Error(
      'Sealed harness-bootstrap runtime must exclude the ordinary src/cli.ts entrypoint.',
    );
  }
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  const pinBytes = pinSource(sha256(manifestBytes));

  if (mode === '--check') {
    assertSameTree(staging, RUNTIME_ROOT);
    assertSameFile(MANIFEST_PATH, manifestBytes);
    assertSameFile(PIN_PATH, pinBytes);
    process.stdout.write(
      `${JSON.stringify({
        kind: 'harness-bootstrap-runtime-generation.v1',
        mode: 'check',
        files: files.length,
        manifestDigest: sha256(manifestBytes),
      })}\n`,
    );
  } else {
    replaceRuntime(staging, RUNTIME_ROOT);
    fs.writeFileSync(MANIFEST_PATH, manifestBytes, { mode: 0o644 });
    fs.chmodSync(MANIFEST_PATH, 0o644);
    fs.writeFileSync(PIN_PATH, pinBytes, { mode: 0o644 });
    fs.chmodSync(PIN_PATH, 0o644);
    fsyncFile(MANIFEST_PATH);
    fsyncFile(PIN_PATH);
    fsyncDirectory(import.meta.dirname);
    process.stdout.write(
      `${JSON.stringify({
        kind: 'harness-bootstrap-runtime-generation.v1',
        mode: 'write',
        files: files.length,
        manifestDigest: sha256(manifestBytes),
      })}\n`,
    );
  }
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}

function compileRuntime(outputRoot: string): void {
  fs.mkdirSync(outputRoot, { recursive: false, mode: 0o700 });
  const tsc = path.join(REPOSITORY_ROOT, 'node_modules', '.bin', 'tsc');
  const result = childProcess.spawnSync(
    tsc,
    [
      '--module',
      'NodeNext',
      '--target',
      'ES2023',
      '--moduleResolution',
      'NodeNext',
      '--typeRoots',
      path.join(PACKAGE_ROOT, 'node_modules', '@types'),
      '--types',
      'node',
      '--skipLibCheck',
      '--strict',
      '--noEmit',
      'false',
      '--allowImportingTsExtensions',
      'false',
      '--rewriteRelativeImportExtensions',
      '--rootDir',
      PACKAGE_ROOT,
      '--outDir',
      outputRoot,
      path.join(PACKAGE_ROOT, 'src', 'harness-bootstrap.ts'),
    ],
    {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
      env: process.env,
      windowsHide: true,
    },
  );
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0 || result.signal !== null) {
    throw new Error(
      `Harness-bootstrap runtime compilation failed.\n${result.stdout}${result.stderr}`,
    );
  }
}

function replaceRuntime(stagedRoot: string, targetRoot: string): void {
  const previous = `${targetRoot}.previous`;
  fs.rmSync(previous, { recursive: true, force: true });
  if (fs.lstatSync(targetRoot, { throwIfNoEntry: false })) {
    fs.renameSync(targetRoot, previous);
  }
  try {
    fs.renameSync(stagedRoot, targetRoot);
    fsyncDirectory(import.meta.dirname);
    fs.rmSync(previous, { recursive: true, force: true });
  } catch (error) {
    if (
      !fs.lstatSync(targetRoot, { throwIfNoEntry: false }) &&
      fs.lstatSync(previous, { throwIfNoEntry: false })
    ) {
      fs.renameSync(previous, targetRoot);
    }
    throw error;
  }
}

function assertSameTree(expectedRoot: string, actualRoot: string): void {
  const expected = listFiles(expectedRoot).map((filePath) =>
    path.relative(expectedRoot, filePath).split(path.sep).join('/'),
  );
  const actual = listFiles(actualRoot).map((filePath) =>
    path.relative(actualRoot, filePath).split(path.sep).join('/'),
  );
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('Sealed harness-bootstrap runtime file set is stale.');
  }
  for (const relative of expected) {
    const expectedPath = path.join(expectedRoot, relative);
    const actualPath = path.join(actualRoot, relative);
    const expectedStats = fs.lstatSync(expectedPath);
    const actualStats = fs.lstatSync(actualPath);
    if (
      actualStats.isSymbolicLink() ||
      !actualStats.isFile() ||
      (actualStats.mode & 0o777) !== (expectedStats.mode & 0o777) ||
      !fs.readFileSync(actualPath).equals(fs.readFileSync(expectedPath))
    ) {
      throw new Error(`Sealed harness-bootstrap runtime is stale: ${relative}`);
    }
  }
}

function assertSameFile(filePath: string, expected: string): void {
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (
    !stats?.isFile() ||
    stats.isSymbolicLink() ||
    (stats.mode & 0o777) !== 0o644 ||
    fs.readFileSync(filePath, 'utf8') !== expected
  ) {
    throw new Error(`${path.basename(filePath)} is stale.`);
  }
}

function listFiles(root: string): string[] {
  const rootStats = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error(`Runtime directory is missing or unsafe: ${root}`);
  }
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const candidate = path.join(directory, name);
      const stats = fs.lstatSync(candidate);
      if (stats.isSymbolicLink()) {
        throw new Error(`Runtime contains a symbolic link: ${candidate}`);
      }
      if (stats.isDirectory()) visit(candidate);
      else if (stats.isFile()) files.push(candidate);
      else
        throw new Error(`Runtime contains an unsupported entry: ${candidate}`);
    }
  };
  visit(root);
  return files.sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

function pinSource(digest: `sha256:${string}`): string {
  return [
    '/** Generated by generate-harness-bootstrap-runtime.ts. */',
    'export const HARNESS_BOOTSTRAP_RUNTIME_CLOSURE_MANIFEST_DIGEST =',
    `  '${digest}' as const;`,
    '',
  ].join('\n');
}

function sha256(value: string | Buffer): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function fsyncFile(filePath: string): void {
  const descriptor = fs.openSync(filePath, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}
