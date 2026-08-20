import fs from 'node:fs';
import path from 'node:path';

const ROOT_PACKAGE_NAME = '@expense/workflow-engine';
const ROOT_SOURCE_ROOT = 'packages/workflow-engine';
const WORKSPACE_SPEC = 'workspace:*';
const RUNTIME_DEPENDENCY_FIELDS = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

export type WorkspaceSourcePackage = Readonly<{
  name: string;
  sourceRoot: string;
  closureRoot: string;
}>;

export type WorkspaceSourceExport = Readonly<{
  subpath: string;
  sourcePath: string;
}>;

type IndexedWorkspacePackage = Readonly<{
  descriptor: WorkspaceSourcePackage;
  dependencies: readonly string[];
  exports: readonly WorkspaceSourceExport[];
}>;

/**
 * Resolve the exact source packages needed by the workflow-engine runtime.
 *
 * Only exact `workspace:*` runtime edges are admitted. The result is sorted by
 * its projected closure path and recursively frozen so callers can safely use
 * it as generator input without observing manifest-order differences.
 */
export function resolveWorkspaceSourceClosure(
  repositoryRoot: string,
): readonly WorkspaceSourcePackage[] {
  return normalizeErrors(() => {
    const index = indexWorkspacePackages(repositoryRoot);
    const root = index.bySourceRoot.get(ROOT_SOURCE_ROOT);
    if (root === undefined || root.descriptor.name !== ROOT_PACKAGE_NAME) {
      throw closureError(
        `root package must be ${ROOT_PACKAGE_NAME} at ${ROOT_SOURCE_ROOT}`,
      );
    }

    const reachable = new Map<string, WorkspaceSourcePackage>();
    const state = new Map<string, 'visiting' | 'visited'>();
    const visit = (packageName: string): void => {
      if (state.get(packageName) === 'visiting') {
        throw closureError(`runtime dependency cycle includes ${packageName}`);
      }
      if (state.get(packageName) === 'visited') return;
      const current = index.byName.get(packageName);
      if (current === undefined) {
        throw closureError(`runtime dependency ${packageName} is missing`);
      }
      state.set(packageName, 'visiting');
      for (const dependencyName of current.dependencies) {
        visit(dependencyName);
      }
      state.set(packageName, 'visited');
      reachable.set(packageName, current.descriptor);
    };

    visit(ROOT_PACKAGE_NAME);
    const descriptors = [...reachable.values()].sort((left, right) =>
      compareCodePoints(left.closureRoot, right.closureRoot),
    );
    return Object.freeze(descriptors);
  });
}

/**
 * Read one admitted package's exact public export-to-source mapping.
 * Source paths are package-relative POSIX paths suitable for mechanical
 * `.ts` to `.js` projection by bootstrap generators.
 */
export function resolveWorkspaceSourceExports(
  repositoryRoot: string,
  descriptor: WorkspaceSourcePackage,
): readonly WorkspaceSourceExport[] {
  return normalizeErrors(() => {
    const closure = resolveWorkspaceSourceClosure(repositoryRoot);
    const admitted = closure.find(
      (candidate) =>
        candidate.name === descriptor.name &&
        candidate.sourceRoot === descriptor.sourceRoot &&
        candidate.closureRoot === descriptor.closureRoot,
    );
    if (admitted === undefined) {
      throw closureError('export lookup descriptor is not in the closure');
    }
    const index = indexWorkspacePackages(repositoryRoot);
    const current = index.byName.get(admitted.name);
    if (current === undefined) {
      throw closureError(`export lookup package ${admitted.name} is missing`);
    }
    return current.exports;
  });
}

function indexWorkspacePackages(repositoryRoot: string): Readonly<{
  byName: ReadonlyMap<string, IndexedWorkspacePackage>;
  bySourceRoot: ReadonlyMap<string, IndexedWorkspacePackage>;
}> {
  const root = requireCanonicalDirectory(path.resolve(repositoryRoot));
  const packagesRoot = requireCanonicalDirectory(path.join(root, 'packages'));
  assertContained(root, packagesRoot);

  const byName = new Map<string, IndexedWorkspacePackage>();
  const bySourceRoot = new Map<string, IndexedWorkspacePackage>();
  const foldedNames = new Map<string, string>();
  const foldedSourceRoots = new Map<string, string>();
  const entries = fs
    .readdirSync(packagesRoot, { withFileTypes: true })
    .sort((left, right) => compareCodePoints(left.name, right.name));

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw closureError(
        `packages entry ${entry.name} is not a plain directory`,
      );
    }
    if (!isSafePathSegment(entry.name)) {
      throw closureError(`source root segment ${entry.name} is unsafe`);
    }
    const packageRoot = requireCanonicalDirectory(
      path.join(packagesRoot, entry.name),
    );
    assertContained(packagesRoot, packageRoot);
    const sourceRoot = `packages/${entry.name}`;
    assertCaseFoldUnique(foldedSourceRoots, sourceRoot, 'source root');
    const manifestPath = path.join(packageRoot, 'package.json');
    requireSafeRegularFile(root, manifestPath, 'package manifest');
    const manifest = readManifest(manifestPath);
    const packageName = manifest.name;
    if (typeof packageName !== 'string') {
      throw closureError(`package at ${sourceRoot} has no name`);
    }
    assertCaseFoldUnique(foldedNames, packageName, 'package name');
    if (!isSafePackageName(packageName)) {
      throw closureError(`package name ${packageName} is unsafe`);
    }
    if (byName.has(packageName)) {
      throw closureError(`package name ${packageName} is duplicated`);
    }

    const closureRoot =
      packageName === ROOT_PACKAGE_NAME
        ? '.'
        : isJigwrightPackageName(packageName)
          ? `node_modules/${packageName}`
          : (() => {
              throw closureError(
                `workspace package ${packageName} has no supported closure root`,
              );
            })();
    const descriptor = Object.freeze({
      name: packageName,
      sourceRoot,
      closureRoot,
    });
    const indexed = Object.freeze({
      descriptor,
      dependencies: readRuntimeDependencies(manifest, sourceRoot),
      exports: readExports(root, packageRoot, manifest.exports),
    });
    byName.set(packageName, indexed);
    bySourceRoot.set(sourceRoot, indexed);
  }

  return Object.freeze({ byName, bySourceRoot });
}

function readRuntimeDependencies(
  manifest: Record<string, unknown>,
  sourceRoot: string,
): readonly string[] {
  const dependencies = new Map<string, string>();
  const folded = new Map<string, string>();
  for (const field of RUNTIME_DEPENDENCY_FIELDS) {
    const value = manifest[field];
    if (value === undefined) continue;
    if (!isRecord(value)) {
      throw closureError(`${sourceRoot} ${field} must be an object`);
    }
    for (const [dependencyName, spec] of Object.entries(value)) {
      assertCaseFoldUnique(folded, dependencyName, 'runtime dependency');
      if (!isJigwrightPackageName(dependencyName)) {
        throw closureError(
          `${sourceRoot} runtime dependency ${dependencyName} is unsafe`,
        );
      }
      if (typeof spec !== 'string' || spec !== WORKSPACE_SPEC) {
        throw closureError(
          `${sourceRoot} runtime dependency ${dependencyName} must use ${WORKSPACE_SPEC} without an alias`,
        );
      }
      if (dependencies.has(dependencyName)) {
        throw closureError(
          `${sourceRoot} declares runtime dependency ${dependencyName} more than once`,
        );
      }
      dependencies.set(dependencyName, field);
    }
  }
  return Object.freeze([...dependencies.keys()].sort(compareCodePoints));
}

function readExports(
  repositoryRoot: string,
  packageRoot: string,
  value: unknown,
): readonly WorkspaceSourceExport[] {
  if (value === undefined) return Object.freeze([]);
  if (!isRecord(value) || Object.keys(value).length === 0) {
    throw closureError('package exports must be a non-empty object');
  }

  const foldedSubpaths = new Map<string, string>();
  const exports = Object.entries(value).map(([subpath, target]) => {
    assertCaseFoldUnique(foldedSubpaths, subpath, 'package export subpath');
    if (!isSafeExportSubpath(subpath)) {
      throw closureError(`package export subpath ${subpath} is unsafe`);
    }
    if (typeof target !== 'string' || !isSafeExportTarget(target)) {
      throw closureError(`package export target for ${subpath} is unsafe`);
    }
    const sourcePath = target.slice(2);
    const sourceFile = path.join(packageRoot, ...sourcePath.split('/'));
    assertContained(packageRoot, sourceFile);
    requireSafeRegularFile(repositoryRoot, sourceFile, 'package export source');
    return Object.freeze({ subpath, sourcePath });
  });
  exports.sort((left, right) => compareCodePoints(left.subpath, right.subpath));
  return Object.freeze(exports);
}

function readManifest(manifestPath: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown;
  } catch (error) {
    throw closureError(
      `package manifest is not valid JSON: ${errorMessage(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw closureError('package manifest must be an object');
  }
  return parsed;
}

function requireCanonicalDirectory(directory: string): string {
  const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (
    stats === undefined ||
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    fs.realpathSync(directory) !== directory
  ) {
    throw closureError(`directory ${directory} is unsafe`);
  }
  return directory;
}

function requireSafeRegularFile(
  allowedRoot: string,
  filePath: string,
  label: string,
): void {
  assertContained(allowedRoot, filePath);
  const relative = path.relative(allowedRoot, filePath);
  let current = allowedRoot;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const stats = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stats === undefined || stats.isSymbolicLink()) {
      throw closureError(`${label} ${filePath} is missing or symlinked`);
    }
    if (current !== filePath) {
      if (!stats.isDirectory() || fs.realpathSync(current) !== current) {
        throw closureError(`${label} ${filePath} crosses an unsafe directory`);
      }
    } else if (
      !stats.isFile() ||
      stats.nlink !== 1 ||
      fs.realpathSync(current) !== current
    ) {
      throw closureError(
        `${label} ${filePath} is not a single-link regular file`,
      );
    }
  }
}

function assertContained(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw closureError(`path ${target} escapes ${root}`);
  }
}

function assertCaseFoldUnique(
  observed: Map<string, string>,
  value: string,
  label: string,
): void {
  const folded = value.normalize('NFC').toLowerCase();
  const previous = observed.get(folded);
  if (previous !== undefined) {
    throw closureError(`${label} ${value} collides with ${previous}`);
  }
  observed.set(folded, value);
}

function isSafePackageName(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > 214 ||
    value.normalize('NFC') !== value
  ) {
    return false;
  }
  if (value.startsWith('@')) {
    const segments = value.slice(1).split('/');
    return segments.length === 2 && segments.every(isSafePathSegment);
  }
  return isSafePathSegment(value);
}

function isJigwrightPackageName(value: string): boolean {
  return value.startsWith('@jigwright/') && isSafePackageName(value);
}

function isSafePathSegment(value: string): boolean {
  return (
    value.normalize('NFC') === value &&
    /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(value)
  );
}

function isSafeExportSubpath(value: string): boolean {
  if (value === '.') return true;
  if (!value.startsWith('./') || value.normalize('NFC') !== value) return false;
  const segments = value.slice(2).split('/');
  return segments.length > 0 && segments.every(isSafePathSegment);
}

function isSafeExportTarget(value: string): boolean {
  if (
    !value.startsWith('./src/') ||
    value.normalize('NFC') !== value ||
    value.includes('\\') ||
    !value.endsWith('.ts')
  ) {
    return false;
  }
  const segments = value.slice(2).split('/');
  return (
    segments.length >= 2 &&
    segments[0] === 'src' &&
    segments.every(isSafePathSegment)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function closureError(message: string): Error {
  return new Error(`Workspace source closure invalid: ${message}`);
}

function normalizeErrors<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith('Workspace source closure invalid:')
    ) {
      throw error;
    }
    throw closureError(errorMessage(error));
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
