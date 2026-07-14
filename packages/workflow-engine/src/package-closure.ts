import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

type DeclaredDependency = {
  name: string;
  spec: string;
  optional: boolean;
};

type ResolvedDeclaredPackage = {
  manifestPath: string;
  manifest: Record<string, unknown>;
  installedName: string;
};

export type PackageClosureEntry =
  { kind: 'file'; filePath: string } | { kind: 'symlink'; linkPath: string };

export function collectWorkspacePackageClosure(
  repositoryRoot: string,
  workspaceManifestPath: string,
  workspaceManifest: Record<string, unknown>,
): PackageClosureEntry[] {
  const workspaceDependencies = declaredDependencies(workspaceManifest, true);
  const workspaceIdentities = new Map(
    workspaceDependencies.map((dependency) => [
      dependency.name,
      declaredPackageIdentity(dependency.name, dependency.spec),
    ]),
  );
  const pending = workspaceDependencies.flatMap((dependency) => {
    const resolved = resolveDeclaredPackage(
      repositoryRoot,
      workspaceManifestPath,
      dependency.name,
      dependency.spec,
      dependency.optional,
    );
    return resolved ? [resolved.manifestPath] : [];
  });
  const visitedManifests = new Set<string>();
  const closureEntries = new Map<string, PackageClosureEntry>();

  while (pending.length > 0) {
    const currentManifestPath = pending.shift();
    if (!currentManifestPath || visitedManifests.has(currentManifestPath)) {
      continue;
    }
    visitedManifests.add(currentManifestPath);
    const manifest = readJsonRecord(currentManifestPath);
    const packageDirectory = fs.realpathSync(path.dirname(currentManifestPath));
    assertInside(repositoryRoot, packageDirectory);
    for (const entry of listPackageEntries(repositoryRoot, packageDirectory)) {
      const entryPath = entry.kind === 'file' ? entry.filePath : entry.linkPath;
      closureEntries.set(`${entry.kind}:${entryPath}`, entry);
    }

    for (const dependency of declaredDependencies(manifest, false)) {
      if (
        createRequire(currentManifestPath).resolve.paths(dependency.name) ===
        null
      ) {
        continue;
      }
      const resolved = resolveDeclaredPackage(
        repositoryRoot,
        currentManifestPath,
        dependency.name,
        dependency.spec,
        dependency.optional,
        declaredPackageIdentity(dependency.name, dependency.spec) ===
          dependency.name
          ? workspaceIdentities.get(dependency.name)
          : undefined,
      );
      if (resolved) {
        pending.push(resolved.manifestPath);
      }
    }
  }

  return [...closureEntries.values()].sort((left, right) => {
    const leftPath = left.kind === 'file' ? left.filePath : left.linkPath;
    const rightPath = right.kind === 'file' ? right.filePath : right.linkPath;
    return (
      leftPath.localeCompare(rightPath) || left.kind.localeCompare(right.kind)
    );
  });
}

export function resolveDeclaredPackage(
  repositoryRoot: string,
  requiringManifestPath: string,
  packageName: string,
  declaredSpec: string,
  optional = false,
  alternateIdentity?: string,
): ResolvedDeclaredPackage | undefined {
  if (!isPackageName(packageName)) {
    throw new Error('unsafe package name');
  }
  const searchPaths =
    createRequire(requiringManifestPath).resolve.paths(packageName) ?? [];
  for (const searchPath of searchPaths) {
    const packageEntry = path.join(searchPath, packageName);
    assertNoLoadAsFileShadow(packageEntry);
    const entryStats = fs.lstatSync(packageEntry, { throwIfNoEntry: false });
    if (!entryStats) {
      continue;
    }
    const packageDirectory = fs.realpathSync(packageEntry);
    assertInside(repositoryRoot, packageDirectory);
    if (!fs.statSync(packageDirectory).isDirectory()) {
      throw new Error('resolved package entry is not a directory');
    }
    const candidate = path.join(packageDirectory, 'package.json');
    if (!fs.lstatSync(candidate, { throwIfNoEntry: false })) {
      throw new Error('resolved package directory has no manifest');
    }
    const manifestPath = fs.realpathSync(candidate);
    assertRegularFileInside(repositoryRoot, manifestPath);
    const manifest = readJsonRecord(manifestPath);
    const installedName = manifest.name;
    if (typeof installedName !== 'string' || !isPackageName(installedName)) {
      throw new Error('resolved package identity is missing');
    }
    const declaredIdentity = declaredPackageIdentity(packageName, declaredSpec);
    if (
      installedName !== declaredIdentity &&
      installedName !== alternateIdentity
    ) {
      throw new Error(
        `resolved package ${packageName} identity does not match its declaration`,
      );
    }
    return { manifestPath, manifest, installedName };
  }
  if (!optional) {
    throw new Error('required runner dependency is unavailable');
  }
  return undefined;
}

function declaredDependencies(
  manifest: Record<string, unknown>,
  includeDevelopment: boolean,
): DeclaredDependency[] {
  const dependencies = stringMap(manifest.dependencies);
  const developmentDependencies = includeDevelopment
    ? stringMap(manifest.devDependencies)
    : {};
  const optionalDependencies = stringMap(manifest.optionalDependencies);
  const peerDependencies = stringMap(manifest.peerDependencies);
  const peerMetadata = isRecord(manifest.peerDependenciesMeta)
    ? manifest.peerDependenciesMeta
    : {};
  const names = new Set([
    ...Object.keys(dependencies),
    ...Object.keys(developmentDependencies),
    ...Object.keys(optionalDependencies),
    ...Object.keys(peerDependencies),
  ]);

  return [...names].sort().map((name) => {
    if (!isPackageName(name)) {
      throw new Error('package manifest contains an unsafe dependency name');
    }
    const specs = [
      dependencies[name],
      developmentDependencies[name],
      optionalDependencies[name],
      peerDependencies[name],
    ].filter((value): value is string => typeof value === 'string');
    const identities = new Set(
      specs.map((spec) => declaredPackageIdentity(name, spec)),
    );
    if (identities.size !== 1) {
      throw new Error('package dependency declarations disagree on identity');
    }
    const peerOptions = peerMetadata[name];
    const optionalPeer = isRecord(peerOptions) && peerOptions.optional === true;
    return {
      name,
      spec: specs[0],
      optional: Object.hasOwn(optionalDependencies, name) || optionalPeer,
    };
  });
}

function listPackageEntries(
  repositoryRoot: string,
  packageDirectory: string,
): PackageClosureEntry[] {
  const entries: PackageClosureEntry[] = [];
  const visitedDirectories = new Set<string>();

  const visit = (directory: string): void => {
    const realDirectory = fs.realpathSync(directory);
    assertInside(repositoryRoot, realDirectory);
    if (visitedDirectories.has(realDirectory)) {
      return;
    }
    visitedDirectories.add(realDirectory);

    const directoryEntries = fs
      .readdirSync(realDirectory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of directoryEntries) {
      const entryPath = path.join(realDirectory, entry.name);
      const entryStats = fs.lstatSync(entryPath);
      if (entryStats.isSymbolicLink()) {
        entries.push({ kind: 'symlink', linkPath: entryPath });
      }
      const realPath = fs.realpathSync(entryPath);
      assertInside(repositoryRoot, realPath);
      const stats = fs.statSync(realPath);
      if (stats.isDirectory()) {
        visit(realPath);
      } else if (stats.isFile()) {
        entries.push({ kind: 'file', filePath: realPath });
      } else {
        throw new Error('package closure contains an unsupported entry');
      }
    }
  };

  visit(packageDirectory);
  return entries;
}

function declaredPackageIdentity(
  packageName: string,
  declaredSpec: string,
): string {
  if (declaredSpec.startsWith('npm:')) {
    return packageNameFromAlias(declaredSpec.slice('npm:'.length));
  }
  if (declaredSpec.startsWith('workspace:')) {
    const workspaceSpec = declaredSpec.slice('workspace:'.length);
    if (/^(?:\*|\^|~|\d)/.test(workspaceSpec)) {
      return packageName;
    }
    return packageNameFromAlias(workspaceSpec);
  }
  return packageName;
}

function packageNameFromAlias(value: string): string {
  const versionSeparator = value.startsWith('@')
    ? value.indexOf('@', value.indexOf('/') + 1)
    : value.indexOf('@');
  const packageName =
    versionSeparator === -1 ? value : value.slice(0, versionSeparator);
  if (!isPackageName(packageName)) {
    throw new Error('runner package alias is invalid');
  }
  return packageName;
}

function readJsonRecord(filePath: string): Record<string, unknown> {
  const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  if (!isRecord(value)) {
    throw new Error('package manifest is invalid');
  }
  return value;
}

function stringMap(value: unknown): Record<string, string> {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error('package dependency field is not an object');
  }
  const entries = Object.entries(value);
  if (entries.some((entry) => typeof entry[1] !== 'string')) {
    throw new Error('package dependency value is not a string');
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function isPackageName(value: string): boolean {
  if (value.length > 214) {
    return false;
  }
  const segments = value.startsWith('@') ? value.slice(1).split('/') : [value];
  return (
    (segments.length === 1 || segments.length === 2) &&
    segments.every((segment) =>
      /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(segment),
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertInside(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error('resolved runner escapes its allowed root');
  }
}

function assertNoLoadAsFileShadow(packageEntry: string): void {
  for (const extension of ['.js', '.json', '.node']) {
    if (
      fs.lstatSync(`${packageEntry}${extension}`, { throwIfNoEntry: false })
    ) {
      throw new Error('package resolution is shadowed by a file entry');
    }
  }
}

function assertRegularFileInside(root: string, target: string): void {
  assertInside(root, target);
  if (!fs.statSync(target).isFile()) {
    throw new Error('resolved package manifest is not a regular file');
  }
}
