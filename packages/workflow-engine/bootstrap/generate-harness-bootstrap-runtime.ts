import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { createTrustedExecutionEnvironment } from '../src/runtime/provider-execution/execution-environment.ts';
import { generateBuiltInEngineClosure } from './generate-built-in-engine-closure.ts';
import {
  resolveWorkspaceSourceClosure,
  resolveWorkspaceSourceExports,
  type WorkspaceSourcePackage,
} from './workspace-source-closure.ts';

const DEFAULT_REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../../..');
const PACKAGE_RELATIVE_PATH = 'packages/workflow-engine';
const RUNTIME_RELATIVE_PATH =
  'packages/workflow-engine/bootstrap/recovery-runtime';
const MANIFEST_RELATIVE_PATH =
  'packages/workflow-engine/bootstrap/harness-bootstrap-dependency-closure.json';
const PIN_RELATIVE_PATH =
  'packages/workflow-engine/bootstrap/harness-bootstrap-runtime-closure-pin.ts';
const ENTRYPOINT = 'bootstrap/recovery-runtime/src/harness-bootstrap.js';
const TRUSTED_HARNESS_TOOLCHAIN_DIGEST =
  'sha256:2374694901978603e8e4234e9f1a2ecac2454312e7d34b9d25e35f47b6c5f7c7' as const;
const MAX_TOOLCHAIN_FILES = 1_000;
const MAX_TOOLCHAIN_BYTES = 64 * 1024 * 1024;

export type HarnessBootstrapRuntimeGenerationMode = '--write' | '--check';

export type HarnessBootstrapRuntimeRender = Readonly<{
  manifest: Readonly<{
    kind: 'harness-bootstrap-dependency-closure.v1';
    entrypoint: typeof ENTRYPOINT;
    boundary: 'sealed-e1-independent-recovery-runtime';
    scope: 'compiled-transitive-runtime';
    claim: string;
    files: readonly Readonly<{
      path: string;
      mode: '100644' | '100755';
      digest: `sha256:${string}`;
    }>[];
  }>;
  runtimeFiles: readonly Readonly<{
    path: string;
    mode: '100644' | '100755';
    digest: `sha256:${string}`;
    contentBase64: string;
  }>[];
  manifestBytes: string;
  manifestDigest: `sha256:${string}`;
  pinBytes: string;
}>;

export type HarnessBootstrapRuntimeGenerationResult = Readonly<{
  kind: 'harness-bootstrap-runtime-generation.v1';
  mode: 'write' | 'check';
  files: number;
  manifestDigest: `sha256:${string}`;
}>;

/** Compile and render the exact recovery closure without mutating its targets. */
export function renderHarnessBootstrapRuntime(
  repositoryRoot: string,
): HarnessBootstrapRuntimeRender {
  return withCompiledRuntime(repositoryRoot, (rendered) => rendered);
}

/** Write or verify the rendered closure under one explicit repository root. */
export function generateHarnessBootstrapRuntime(
  repositoryRoot: string,
  mode: HarnessBootstrapRuntimeGenerationMode,
): HarnessBootstrapRuntimeGenerationResult {
  assertMode(mode);
  return withCompiledRuntime(repositoryRoot, (rendered, staging, root) => {
    const runtimeRoot = path.join(root, RUNTIME_RELATIVE_PATH);
    const manifestPath = path.join(root, MANIFEST_RELATIVE_PATH);
    const pinPath = path.join(root, PIN_RELATIVE_PATH);
    if (mode === '--check') {
      assertSameTree(staging, runtimeRoot);
      assertSameFile(manifestPath, rendered.manifestBytes);
      assertSameFile(pinPath, rendered.pinBytes);
    } else {
      assertReplaceableFile(manifestPath);
      assertReplaceableFile(pinPath);
      replaceRuntime(staging, runtimeRoot);
      replaceTextFile(manifestPath, rendered.manifestBytes);
      replaceTextFile(pinPath, rendered.pinBytes);
      fsyncDirectory(path.dirname(manifestPath));
    }
    return Object.freeze({
      kind: 'harness-bootstrap-runtime-generation.v1' as const,
      mode: mode === '--check' ? ('check' as const) : ('write' as const),
      files: rendered.runtimeFiles.length,
      manifestDigest: rendered.manifestDigest,
    });
  });
}

function withCompiledRuntime<T>(
  repositoryRoot: string,
  operation: (
    rendered: HarnessBootstrapRuntimeRender,
    staging: string,
    root: string,
  ) => T,
): T {
  const root = fs.realpathSync(repositoryRoot);
  const packageRoot = requireContainedDirectory(root, [
    'packages',
    'workflow-engine',
  ]);
  requireContainedDirectory(packageRoot, ['src']);
  const bootstrapRoot = requireContainedDirectory(packageRoot, ['bootstrap']);
  generateBuiltInEngineClosure(root, '--check');
  const staging = path.join(
    bootstrapRoot,
    `.recovery-runtime.${process.pid}.${crypto.randomUUID()}.tmp`,
  );

  try {
    compileRuntime(root, packageRoot, staging);
    const runtimeFiles = listFiles(staging).map((absolute) => {
      const relativeToStaging = path.relative(staging, absolute);
      const runtimePath = path.posix.join(
        'bootstrap/recovery-runtime',
        relativeToStaging.split(path.sep).join('/'),
      );
      const executable = runtimePath === ENTRYPOINT;
      fs.chmodSync(absolute, executable ? 0o755 : 0o644);
      const content = fs.readFileSync(absolute);
      return Object.freeze({
        path: runtimePath,
        mode: executable ? ('100755' as const) : ('100644' as const),
        digest: sha256(content),
        contentBase64: content.toString('base64'),
      });
    });
    const manifestFiles = runtimeFiles.map(({ path: filePath, mode, digest }) =>
      Object.freeze({ path: filePath, mode, digest }),
    );
    const manifest = Object.freeze({
      kind: 'harness-bootstrap-dependency-closure.v1' as const,
      entrypoint: ENTRYPOINT,
      boundary: 'sealed-e1-independent-recovery-runtime' as const,
      scope: 'compiled-transitive-runtime' as const,
      claim:
        'This sealed compiled recovery runtime is independent of the mutable E1 src tree and remains usable when E1 cannot load.',
      files: Object.freeze(manifestFiles),
    });
    if (!manifestFiles.some(({ path: filePath }) => filePath === ENTRYPOINT)) {
      throw new Error('Compiled harness-bootstrap entrypoint is missing.');
    }
    if (
      manifestFiles.some(
        ({ path: filePath }) =>
          filePath === 'bootstrap/recovery-runtime/src/cli.js',
      )
    ) {
      throw new Error(
        'Sealed harness-bootstrap runtime must exclude the ordinary src/cli.ts entrypoint.',
      );
    }
    const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
    const manifestDigest = sha256(manifestBytes);
    const rendered = Object.freeze({
      manifest,
      runtimeFiles: Object.freeze(runtimeFiles),
      manifestBytes,
      manifestDigest,
      pinBytes: pinSource(manifestDigest),
    });
    return operation(rendered, staging, root);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function compileRuntime(
  repositoryRoot: string,
  packageRoot: string,
  outputRoot: string,
): void {
  fs.mkdirSync(outputRoot, { recursive: false, mode: 0o700 });
  const workspacePackages = resolveWorkspaceSourceClosure(repositoryRoot);
  const rawOutputRoot = `${outputRoot}.compiled`;
  const compilerConfigPath = `${outputRoot}.tsconfig.json`;
  if (
    fs.lstatSync(rawOutputRoot, { throwIfNoEntry: false }) !== undefined ||
    fs.lstatSync(compilerConfigPath, { throwIfNoEntry: false }) !== undefined
  ) {
    throw new Error('Harness-bootstrap compiler staging path is occupied.');
  }
  const toolchain = resolveTrustedHarnessToolchain();
  try {
    fs.mkdirSync(rawOutputRoot, { recursive: false, mode: 0o700 });
    const paths = workspaceCompilerPaths(repositoryRoot, workspacePackages);
    const compilerConfig = {
      compilerOptions: {
        module: 'NodeNext',
        target: 'ES2023',
        moduleResolution: 'NodeNext',
        typeRoots: [toolchain.typeRoots],
        types: ['node'],
        skipLibCheck: true,
        strict: true,
        noEmit: false,
        rewriteRelativeImportExtensions: true,
        rootDir: repositoryRoot,
        outDir: rawOutputRoot,
        paths,
      },
      files: [path.join(packageRoot, 'src', 'harness-bootstrap.ts')],
    };
    fs.writeFileSync(
      compilerConfigPath,
      `${JSON.stringify(compilerConfig, null, 2)}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    const result = childProcess.spawnSync(
      fs.realpathSync(process.execPath),
      [toolchain.compilerEntrypoint, '--project', compilerConfigPath],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: createTrustedExecutionEnvironment([toolchain.compilerEntrypoint]),
        windowsHide: true,
      },
    );
    if (result.error !== undefined) throw result.error;
    resolveTrustedHarnessToolchain();
    if (result.status !== 0 || result.signal !== null) {
      throw new Error(
        `Harness-bootstrap runtime compilation failed.\n${result.stdout}${result.stderr}`,
      );
    }
    projectCompiledWorkspaceRuntime(
      repositoryRoot,
      rawOutputRoot,
      outputRoot,
      workspacePackages,
    );
  } finally {
    fs.rmSync(rawOutputRoot, { recursive: true, force: true });
    fs.rmSync(compilerConfigPath, { force: true });
  }
}

function workspaceCompilerPaths(
  repositoryRoot: string,
  workspacePackages: readonly WorkspaceSourcePackage[],
): Record<string, string[]> {
  const entries: Array<[string, string[]]> = workspacePackages
    .slice(1)
    .flatMap((descriptor) =>
      resolveWorkspaceSourceExports(repositoryRoot, descriptor).map(
        ({ subpath, sourcePath }): [string, string[]] => [
          subpath === '.'
            ? descriptor.name
            : `${descriptor.name}${subpath.slice(1)}`,
          [path.join(repositoryRoot, descriptor.sourceRoot, sourcePath)],
        ],
      ),
    );
  return Object.fromEntries(entries);
}

function projectCompiledWorkspaceRuntime(
  repositoryRoot: string,
  rawOutputRoot: string,
  outputRoot: string,
  workspacePackages: readonly WorkspaceSourcePackage[],
): void {
  const projectedFiles = new Set<string>();
  for (const absolute of listFiles(rawOutputRoot)) {
    const rawRelative = path
      .relative(rawOutputRoot, absolute)
      .split(path.sep)
      .join('/');
    const descriptor = workspacePackages.find(
      ({ sourceRoot }) =>
        rawRelative === sourceRoot || rawRelative.startsWith(`${sourceRoot}/`),
    );
    if (descriptor === undefined) {
      throw new Error(
        `Compiled recovery runtime escaped the workspace source closure: ${rawRelative}`,
      );
    }
    const packageRelative = rawRelative.slice(descriptor.sourceRoot.length + 1);
    const projected =
      descriptor.closureRoot === '.'
        ? packageRelative
        : path.posix.join(descriptor.closureRoot, packageRelative);
    const target = path.join(outputRoot, ...projected.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.copyFileSync(absolute, target, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(target, 0o644);
    projectedFiles.add(projected);
  }

  for (const descriptor of workspacePackages.slice(1)) {
    const projectedExports = resolveWorkspaceSourceExports(
      repositoryRoot,
      descriptor,
    )
      .map(({ subpath, sourcePath }) => ({
        subpath,
        target: `./${sourcePath.replace(/\.ts$/, '.js')}`,
        projectedPath: path.posix.join(
          descriptor.closureRoot,
          sourcePath.replace(/\.ts$/, '.js'),
        ),
      }))
      .filter(({ projectedPath }) => projectedFiles.has(projectedPath));
    const emittedForPackage = [...projectedFiles].some((filePath) =>
      filePath.startsWith(`${descriptor.closureRoot}/`),
    );
    if (emittedForPackage && projectedExports.length === 0) {
      throw new Error(
        `Compiled workspace package has no emitted public entrypoint: ${descriptor.name}`,
      );
    }
    if (projectedExports.length === 0) continue;
    const packageJsonPath = path.join(
      outputRoot,
      ...descriptor.closureRoot.split('/'),
      'package.json',
    );
    fs.writeFileSync(
      packageJsonPath,
      `${JSON.stringify(
        {
          name: descriptor.name,
          type: 'module',
          exports: Object.fromEntries(
            projectedExports.map(({ subpath, target }) => [subpath, target]),
          ),
        },
        null,
        2,
      )}\n`,
      { flag: 'wx', mode: 0o644 },
    );
  }
}

function resolveTrustedHarnessToolchain(): Readonly<{
  compilerEntrypoint: string;
  typeRoots: string;
  digest: typeof TRUSTED_HARNESS_TOOLCHAIN_DIGEST;
}> {
  const trustedToolchainRoot = fs.realpathSync(DEFAULT_REPOSITORY_ROOT);
  const dependencyRoot = fs.realpathSync(
    path.join(trustedToolchainRoot, 'node_modules'),
  );
  const packageDependencyRoot = fs.realpathSync(
    path.join(trustedToolchainRoot, PACKAGE_RELATIVE_PATH, 'node_modules'),
  );
  const aliasRoot = fs.realpathSync(path.join(dependencyRoot, 'typescript'));
  const requireFromAlias = createRequire(path.join(aliasRoot, 'package.json'));
  const compilerEntrypoint = requireFromAlias.resolve(
    '@typescript/old/lib/tsc.js',
  );
  const compilerRoot = path.resolve(compilerEntrypoint, '../..');
  const nodeTypesRoot = fs.realpathSync(
    path.join(packageDependencyRoot, '@types', 'node'),
  );
  const undiciTypesRoot = fs.realpathSync(
    path.join(nodeTypesRoot, '../..', 'undici-types'),
  );
  const packages = [
    ['typescript-alias', aliasRoot],
    ['typescript-compiler', compilerRoot],
    ['node-types', nodeTypesRoot],
    ['undici-types', undiciTypesRoot],
  ] as const;
  let fileCount = 0;
  let byteCount = 0;
  const packageEntries = packages.map(([label, root]) => ({
    label,
    files: listToolchainPackageFiles(root).map((file) => {
      fileCount += 1;
      byteCount += file.bytes.length;
      if (fileCount > MAX_TOOLCHAIN_FILES || byteCount > MAX_TOOLCHAIN_BYTES) {
        throw new Error(
          'Trusted harness-bootstrap toolchain exceeds its bound.',
        );
      }
      return {
        path: file.path,
        mode: file.mode,
        digest: sha256(file.bytes),
      };
    }),
  }));
  const observed = sha256(
    JSON.stringify({
      schemaVersion: 1,
      kind: 'harness-bootstrap-toolchain.v1',
      packages: packageEntries,
    }),
  );
  if (observed !== TRUSTED_HARNESS_TOOLCHAIN_DIGEST) {
    throw new Error(
      'Trusted harness-bootstrap compiler or type package bytes do not match the code-owned digest.',
    );
  }
  if (
    compilerEntrypoint !== compilerRoot &&
    !compilerEntrypoint.startsWith(`${compilerRoot}${path.sep}`)
  ) {
    throw new Error(
      'Trusted harness-bootstrap compiler escaped its package root.',
    );
  }
  return Object.freeze({
    compilerEntrypoint,
    typeRoots: path.dirname(nodeTypesRoot),
    digest: TRUSTED_HARNESS_TOOLCHAIN_DIGEST,
  });
}

function listToolchainPackageFiles(root: string): readonly Readonly<{
  path: string;
  mode: '100644' | '100755';
  bytes: Buffer;
}>[] {
  const files: Array<{
    path: string;
    mode: '100644' | '100755';
    bytes: Buffer;
  }> = [];
  const visit = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const stats = fs.lstatSync(absolute);
      if (stats.isSymbolicLink()) {
        throw new Error(
          `Trusted harness-bootstrap toolchain contains a symlink: ${absolute}`,
        );
      }
      if (stats.isDirectory()) {
        visit(absolute);
      } else if (stats.isFile()) {
        files.push({
          path: path.relative(root, absolute).split(path.sep).join('/'),
          mode: (stats.mode & 0o111) === 0 ? '100644' : '100755',
          bytes: fs.readFileSync(absolute),
        });
      } else {
        throw new Error(
          `Trusted harness-bootstrap toolchain contains an unsupported entry: ${absolute}`,
        );
      }
    }
  };
  visit(root);
  return files.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

function replaceRuntime(stagedRoot: string, targetRoot: string): void {
  const previous = `${targetRoot}.previous`;
  if (fs.lstatSync(previous, { throwIfNoEntry: false }) !== undefined) {
    throw new Error(`Recovery runtime previous path is occupied: ${previous}`);
  }
  const targetStats = fs.lstatSync(targetRoot, { throwIfNoEntry: false });
  if (targetStats !== undefined) {
    assertSafeDirectoryTree(targetRoot);
    fs.renameSync(targetRoot, previous);
  }
  try {
    fs.renameSync(stagedRoot, targetRoot);
    fsyncDirectory(path.dirname(targetRoot));
    if (targetStats !== undefined) removeSafeDirectoryTree(previous);
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
      actualStats.nlink !== 1 ||
      (actualStats.mode & 0o777) !== (expectedStats.mode & 0o777) ||
      !fs.readFileSync(actualPath).equals(fs.readFileSync(expectedPath))
    ) {
      throw new Error(`Sealed harness-bootstrap runtime is stale: ${relative}`);
    }
  }
}

function assertReplaceableFile(filePath: string): void {
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (
    stats !== undefined &&
    (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1)
  ) {
    throw new Error(`Harness-bootstrap output is unsafe: ${filePath}`);
  }
}

function replaceTextFile(filePath: string, content: string): void {
  assertReplaceableFile(filePath);
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  if (fs.lstatSync(temporary, { throwIfNoEntry: false }) !== undefined) {
    throw new Error(
      `Harness-bootstrap temporary path is occupied: ${temporary}`,
    );
  }
  try {
    fs.writeFileSync(temporary, content, { flag: 'wx', mode: 0o644 });
    fs.chmodSync(temporary, 0o644);
    fsyncFile(temporary);
    fs.renameSync(temporary, filePath);
    fs.chmodSync(filePath, 0o644);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function assertSameFile(filePath: string, expected: string): void {
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (
    !stats?.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (stats.mode & 0o777) !== 0o644 ||
    fs.readFileSync(filePath, 'utf8') !== expected
  ) {
    throw new Error(`${path.basename(filePath)} is stale.`);
  }
}

function requireContainedDirectory(root: string, segments: string[]): string {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    const stats = fs.lstatSync(current, { throwIfNoEntry: false });
    if (
      stats === undefined ||
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      fs.realpathSync(current) !== current
    ) {
      throw new Error(`Harness-bootstrap directory is unsafe: ${current}`);
    }
  }
  return current;
}

function assertSafeDirectoryTree(root: string): void {
  const rootStats = fs.lstatSync(root, { throwIfNoEntry: false });
  if (
    rootStats === undefined ||
    !rootStats.isDirectory() ||
    rootStats.isSymbolicLink()
  ) {
    throw new Error(`Recovery runtime directory is unsafe: ${root}`);
  }
  for (const name of fs.readdirSync(root)) {
    const candidate = path.join(root, name);
    const stats = fs.lstatSync(candidate);
    if (stats.isDirectory() && !stats.isSymbolicLink()) {
      assertSafeDirectoryTree(candidate);
    } else if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
      throw new Error(`Recovery runtime entry is unsafe: ${candidate}`);
    }
  }
}

function removeSafeDirectoryTree(root: string): void {
  assertSafeDirectoryTree(root);
  for (const name of fs.readdirSync(root)) {
    const candidate = path.join(root, name);
    const stats = fs.lstatSync(candidate);
    if (stats.isDirectory()) removeSafeDirectoryTree(candidate);
    else fs.unlinkSync(candidate);
  }
  fs.rmdirSync(root);
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
      else if (stats.isFile() && stats.nlink === 1) files.push(candidate);
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

function assertMode(
  mode: string,
): asserts mode is HarnessBootstrapRuntimeGenerationMode {
  if (mode !== '--write' && mode !== '--check') {
    throw new Error(
      'Usage: generate-harness-bootstrap-runtime.ts <--write|--check>',
    );
  }
}

if (import.meta.main) {
  const mode = process.argv[2];
  if (mode !== '--write' && mode !== '--check') {
    process.stderr.write(
      'Usage: generate-harness-bootstrap-runtime.ts <--write|--check>\n',
    );
    process.exit(2);
  }
  const result = generateHarnessBootstrapRuntime(DEFAULT_REPOSITORY_ROOT, mode);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
