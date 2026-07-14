import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  parseCheckCommand,
  type CheckDefinition,
  type ParsedCheckCommand,
} from './contracts.ts';
import { ExitCode, WorkflowError, workflowError } from './errors.ts';
import {
  collectWorkspacePackageClosure,
  resolveDeclaredPackage,
  type PackageClosureEntry,
} from './package-closure.ts';

export type ResolvedCheckRunner = {
  runner: string;
  executable: string;
  args: string[];
  digest: string;
};

type RunnerDigestEntry = {
  kind: 'file' | 'symlink';
  path: string;
};

export function resolveCheckRunner(
  repositoryRoot: string,
  checkId: string,
  definition: CheckDefinition,
): ResolvedCheckRunner {
  const command = parseCheckCommand(definition.command);
  if (!command) {
    throw unsafeRunner(checkId);
  }

  try {
    const repositoryRealPath = fs.realpathSync(repositoryRoot);
    const nodeExecutable = fs.realpathSync(process.execPath);
    return command.runner === 'node'
      ? resolveNodeRunner(repositoryRealPath, nodeExecutable, command)
      : resolvePackageRunner(repositoryRealPath, nodeExecutable, command);
  } catch (error) {
    if (error instanceof WorkflowError) {
      throw error;
    }
    throw workflowError(
      'CHECK_RUNNER_UNAVAILABLE',
      `Required check ${checkId} could not resolve its declared runner.`,
      ExitCode.unsafeEnvironment,
      { details: { checkId } },
    );
  }
}

function resolveNodeRunner(
  repositoryRoot: string,
  nodeExecutable: string,
  command: Extract<ParsedCheckCommand, { runner: 'node' }>,
): ResolvedCheckRunner {
  const entrypointPaths = command.entrypoints.map((entrypoint) => {
    const entrypointPath = fs.realpathSync(
      path.join(repositoryRoot, entrypoint),
    );
    assertRegularFileInside(repositoryRoot, entrypointPath);
    return entrypointPath;
  });

  return {
    runner: 'node',
    executable: nodeExecutable,
    args: resolvedNodeArgs(command.args, entrypointPaths),
    digest: digestFiles(
      repositoryRoot,
      nodeExecutable,
      entrypointPaths.map((entrypointPath) => ({
        kind: 'file',
        path: entrypointPath,
      })),
    ),
  };
}

function resolvedNodeArgs(args: string[], entrypointPaths: string[]): string[] {
  if (args[0] === '--test') {
    return ['--test', ...entrypointPaths];
  }
  if (args[0] === '--experimental-strip-types' && args[1] === '--test') {
    return ['--experimental-strip-types', '--test', ...entrypointPaths];
  }
  return [entrypointPaths[0], ...args.slice(1)];
}

function resolvePackageRunner(
  repositoryRoot: string,
  nodeExecutable: string,
  command: Extract<ParsedCheckCommand, { runner: 'node-package-bin' }>,
): ResolvedCheckRunner {
  const { workspace, packageName, binName, args } = command;
  const workspacePath = fs.realpathSync(
    workspace === '.' ? repositoryRoot : path.join(repositoryRoot, workspace),
  );
  assertInsideRepository(repositoryRoot, workspacePath);
  if (!fs.statSync(workspacePath).isDirectory()) {
    throw new Error('declared workspace is not a directory');
  }
  const workspaceManifestPath = fs.realpathSync(
    path.join(workspacePath, 'package.json'),
  );
  assertRegularFileInside(workspacePath, workspaceManifestPath);
  const workspaceManifest = readJsonRecord(workspaceManifestPath);
  const declaredPackageSpec = packageDependencySpec(
    workspaceManifest,
    packageName,
  );

  const resolvedPackage = resolveDeclaredPackage(
    repositoryRoot,
    workspaceManifestPath,
    packageName,
    declaredPackageSpec,
  );
  if (!resolvedPackage) {
    throw new Error('declared package is unavailable inside the repository');
  }
  const { manifestPath, manifest, installedName } = resolvedPackage;
  const relativeBin = packageBin(manifest.bin, installedName, binName);
  const packageDirectory = fs.realpathSync(path.dirname(manifestPath));
  const binPath = fs.realpathSync(path.resolve(packageDirectory, relativeBin));
  assertRegularFileInside(packageDirectory, binPath);
  const closureFiles = collectWorkspacePackageClosure(
    repositoryRoot,
    workspaceManifestPath,
    workspaceManifest,
  );

  return {
    runner: `node-package-bin:${workspace}:${packageName}/${binName}`,
    executable: nodeExecutable,
    args: [binPath, ...args],
    digest: digestFiles(repositoryRoot, nodeExecutable, [
      { kind: 'file', path: workspaceManifestPath },
      ...closureFiles.map(packageClosureDigestEntry),
    ]),
  };
}

function packageDependencySpec(
  value: Record<string, unknown>,
  packageName: string,
): string {
  for (const field of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
  ]) {
    const dependencies = stringMap(value[field]);
    if (Object.hasOwn(dependencies, packageName)) {
      return dependencies[packageName];
    }
  }
  throw new Error('runner package is not a declared workspace dependency');
}

function packageBin(
  value: unknown,
  packageName: string,
  binName: string,
): string {
  if (typeof value === 'string') {
    const defaultBinName = packageName.includes('/')
      ? packageName.slice(packageName.lastIndexOf('/') + 1)
      : packageName;
    if (binName === defaultBinName) {
      return assertRelativePackagePath(value);
    }
  } else if (
    isRecord(value) &&
    Object.hasOwn(value, binName) &&
    typeof value[binName] === 'string'
  ) {
    return assertRelativePackagePath(value[binName]);
  }
  throw new Error('package bin is missing');
}

function assertRelativePackagePath(value: string): string {
  if (
    value.trim() !== value ||
    path.isAbsolute(value) ||
    /^[a-zA-Z]:/.test(value) ||
    value.includes('\\') ||
    hasControlCharacters(value)
  ) {
    throw new Error('package bin path is unsafe');
  }
  const segments = value.replace(/^\.\//, '').split('/');
  if (
    segments.length === 0 ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error('package bin path is unsafe');
  }
  return value;
}

function readJsonRecord(filePath: string): Record<string, unknown> {
  const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  if (!isRecord(value)) {
    throw new Error('package manifest is invalid');
  }
  return value;
}

function stringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function digestFiles(
  repositoryRoot: string,
  nodeExecutable: string,
  repositoryEntries: RunnerDigestEntry[],
): string {
  const digest = crypto.createHash('sha256');
  const uniqueRepositoryEntries = new Map(
    repositoryEntries.map((entry) => [`${entry.kind}:${entry.path}`, entry]),
  );
  const entries = [
    { kind: 'file' as const, path: nodeExecutable, identity: 'runtime:node' },
    ...[...uniqueRepositoryEntries.values()].map((entry) => ({
      ...entry,
      identity: repositoryFileIdentity(repositoryRoot, entry.path),
    })),
  ];
  entries.sort(
    (left, right) =>
      left.identity.localeCompare(right.identity) ||
      left.kind.localeCompare(right.kind),
  );
  for (const entry of entries) {
    updateFramed(digest, 'entry-kind', entry.kind);
    updateFramed(digest, 'entry-identity', entry.identity);
    updateFramed(
      digest,
      entry.kind === 'file' ? 'entry-content' : 'entry-target',
      entry.kind === 'file'
        ? fs.readFileSync(entry.path)
        : fs.readlinkSync(entry.path),
    );
  }
  return digest.digest('hex');
}

function packageClosureDigestEntry(
  entry: PackageClosureEntry,
): RunnerDigestEntry {
  return entry.kind === 'file'
    ? { kind: 'file', path: entry.filePath }
    : { kind: 'symlink', path: entry.linkPath };
}

function updateFramed(
  digest: ReturnType<typeof crypto.createHash>,
  domain: string,
  value: string | Buffer,
): void {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  digest.update(`${domain.length}:${domain}:${bytes.length}:`);
  digest.update(bytes);
}

function repositoryFileIdentity(
  repositoryRoot: string,
  filePath: string,
): string {
  const relative = path.relative(repositoryRoot, filePath);
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error('runner digest contains an external repository file');
  }
  return `repository:${relative.split(path.sep).join('/')}`;
}

function assertInsideRepository(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error('resolved runner escapes its allowed root');
  }
}

function assertRegularFileInside(root: string, target: string): void {
  assertInsideRepository(root, target);
  if (!fs.statSync(target).isFile()) {
    throw new Error('resolved runner entrypoint is not a regular file');
  }
}

function unsafeRunner(checkId: string): WorkflowError {
  return workflowError(
    'UNSAFE_CHECK_RUNNER',
    `Required check ${checkId} does not use an allowed runner.`,
    ExitCode.unsafeEnvironment,
    { details: { checkId } },
  );
}
