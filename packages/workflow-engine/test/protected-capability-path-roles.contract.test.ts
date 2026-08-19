import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  compressionEligible,
  parsePathRoleRegistry,
  resolvePathRole,
} from '../src/modules/source/path-role-registry.ts';

type ProtectedCapabilityManifest = Readonly<{
  manifestPath: string;
  entries: ReadonlyArray<
    Readonly<{
      entrypoints: readonly string[];
      dependencies: readonly string[];
    }>
  >;
}>;

function repositoryRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
}

function representativePath(policyPath: string): string {
  return policyPath.endsWith('/**') ? policyPath.slice(0, -3) : policyPath;
}

test('every protected capability path resolves to a non-compressible role', () => {
  const root = repositoryRoot();
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(root, 'workflow/protected-capabilities.json'),
      'utf8',
    ),
  ) as ProtectedCapabilityManifest;
  const registry = parsePathRoleRegistry(
    JSON.parse(
      fs.readFileSync(path.join(root, 'workflow/path-roles.json'), 'utf8'),
    ),
  );
  const protectedPaths = [
    manifest.manifestPath,
    ...manifest.entries.flatMap(({ entrypoints, dependencies }) => [
      ...entrypoints,
      ...dependencies,
    ]),
  ];

  const offenders = [...new Set(protectedPaths)]
    .sort()
    .flatMap((protectedPath) => {
      const resolution = resolvePathRole(
        registry,
        representativePath(protectedPath),
      );
      return resolution.registered && !compressionEligible(resolution)
        ? []
        : [
            {
              path: protectedPath,
              role: resolution.role,
              pattern: resolution.pattern,
            },
          ];
    });

  assert.deepEqual(
    offenders,
    [],
    `Protected capability paths must not fall through to ordinary or unregistered roles:\n${JSON.stringify(offenders, null, 2)}`,
  );
});
