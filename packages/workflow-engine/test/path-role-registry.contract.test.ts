import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  parsePathRoleRegistry,
  resolvePathRole,
  compressionEligible,
  type PathRoleRegistry,
} from '../src/modules/source/path-role-registry.ts';
import { isWorkflowError } from './fixture.ts';

function repositoryRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
}

const REGISTRY: PathRoleRegistry = parsePathRoleRegistry({
  schemaVersion: 1,
  kind: 'path-role-registry',
  roles: {
    'control-plane': ['packages/workflow-engine/bootstrap/**'],
    grant: [
      'packages/workflow-engine/src/modules/authority/maintainer-candidate.ts',
    ],
    lifecycle: [
      'packages/workflow-engine/src/application/propose/planning-transition.ts',
    ],
    policy: ['workflow/**'],
    'verification-infrastructure': ['packages/workflow-engine/test/**'],
    'contract-surface': ['openspec/specs/**'],
    ordinary: ['apps/**', 'packages/workflow-engine/src/**'],
  },
});

test('a path resolves to the role that registers it', () => {
  assert.equal(
    resolvePathRole(REGISTRY, 'workflow/checks.json').role,
    'policy',
  );
  assert.equal(
    resolvePathRole(REGISTRY, 'openspec/specs/workflow-assurance/spec.md').role,
    'contract-surface',
  );
  assert.equal(
    resolvePathRole(REGISTRY, 'apps/mobile/App.tsx').role,
    'ordinary',
  );
});

test('an exact registration outranks a prefix that also covers it', () => {
  // maintainer-candidate.ts sits under the ordinary src prefix, but it is
  // registered by name as grant substrate; the narrower claim has to win or
  // every risky file would be laundered by a broad sibling pattern.
  assert.equal(
    resolvePathRole(
      REGISTRY,
      'packages/workflow-engine/src/modules/authority/maintainer-candidate.ts',
    ).role,
    'grant',
  );
  assert.equal(
    resolvePathRole(
      REGISTRY,
      'packages/workflow-engine/src/modules/provider-orchestration/execution-core.ts',
    ).role,
    'ordinary',
  );
});

test('an unregistered path is unregistered, not ordinary', () => {
  const resolution = resolvePathRole(REGISTRY, 'scripts/release.sh');
  assert.equal(resolution.registered, false);
  assert.equal(resolution.role, null);
});

test('only ordinary and unregistered-free paths may be compressed', () => {
  for (const risky of [
    'workflow/checks.json',
    'openspec/specs/workflow-assurance/spec.md',
    'packages/workflow-engine/src/modules/authority/maintainer-candidate.ts',
    'packages/workflow-engine/src/application/propose/planning-transition.ts',
    'packages/workflow-engine/bootstrap/canonical-json.ts',
    'packages/workflow-engine/test/fixture.ts',
  ]) {
    assert.equal(
      compressionEligible(resolvePathRole(REGISTRY, risky)),
      false,
      risky,
    );
  }
  assert.equal(
    compressionEligible(resolvePathRole(REGISTRY, 'apps/mobile/App.tsx')),
    true,
  );
});

test('an unregistered path fails deep rather than defaulting to compressible', () => {
  assert.equal(
    compressionEligible(resolvePathRole(REGISTRY, 'scripts/release.sh')),
    false,
  );
});

test('a registry that claims one path under two roles is refused', () => {
  assert.throws(
    () =>
      parsePathRoleRegistry({
        schemaVersion: 1,
        kind: 'path-role-registry',
        roles: {
          policy: ['workflow/checks.json'],
          ordinary: ['workflow/checks.json'],
        },
      }),
    (error) => isWorkflowError(error, 'PATH_ROLE_REGISTRY_INVALID'),
  );
});

test('a registry with an unknown role or malformed pattern is refused', () => {
  for (const roles of [
    { imaginary: ['apps/**'] },
    { ordinary: ['/absolute/path'] },
    { ordinary: ['../escape'] },
    { ordinary: [''] },
  ]) {
    assert.throws(
      () =>
        parsePathRoleRegistry({
          schemaVersion: 1,
          kind: 'path-role-registry',
          roles,
        }),
      (error) => isWorkflowError(error, 'PATH_ROLE_REGISTRY_INVALID'),
      JSON.stringify(roles),
    );
  }
});

test('resolution is deterministic regardless of role declaration order', () => {
  const reversed = parsePathRoleRegistry({
    schemaVersion: 1,
    kind: 'path-role-registry',
    roles: {
      ordinary: ['packages/workflow-engine/src/**'],
      grant: [
        'packages/workflow-engine/src/modules/authority/maintainer-candidate.ts',
      ],
    },
  });
  assert.equal(
    resolvePathRole(
      reversed,
      'packages/workflow-engine/src/modules/authority/maintainer-candidate.ts',
    ).role,
    'grant',
  );
});

test('the repository registry classifies its own risky substrate', () => {
  const registry = parsePathRoleRegistry(
    JSON.parse(
      fs.readFileSync(
        path.join(repositoryRoot(), 'workflow/path-roles.json'),
        'utf8',
      ),
    ),
  );
  // These are the surfaces where a wrong class disposition is discovered late.
  for (const [candidate, expected] of [
    ['workflow/checks.json', 'policy'],
    ['workflow/maintainer-policy.json', 'control-plane'],
    ['packages/workflow-engine/bootstrap/canonical-json.ts', 'control-plane'],
    [
      'packages/workflow-engine/src/modules/authority/maintainer-candidate.ts',
      'grant',
    ],
    [
      'packages/workflow-engine/src/application/propose/planning-transition.ts',
      'lifecycle',
    ],
    [
      'packages/workflow-engine/src/modules/assurance/plan-review.ts',
      'contract-surface',
    ],
    ['packages/workflow-engine/test/fixture.ts', 'verification-infrastructure'],
    ['openspec/specs/workflow-assurance/spec.md', 'contract-surface'],
  ] as const) {
    const resolution = resolvePathRole(registry, candidate);
    assert.equal(resolution.role, expected, candidate);
    assert.equal(compressionEligible(resolution), false, candidate);
  }
  const protectedDependency = resolvePathRole(
    registry,
    'packages/workflow-engine/src/runtime/session-workspace/paths.ts',
  );
  assert.equal(protectedDependency.role, 'control-plane');
  assert.equal(compressionEligible(protectedDependency), false);
});
