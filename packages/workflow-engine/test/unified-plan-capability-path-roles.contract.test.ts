import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  compressionEligible,
  parsePathRoleRegistry,
  resolvePathRole,
  type PathRole,
} from '../src/path-role-registry.ts';

const EXPECTED_ROLES: ReadonlyArray<
  readonly [repositoryPath: string, role: PathRole]
> = [
  ['packages/workflow-engine/src/plan-review-coverage.ts', 'control-plane'],
  [
    'packages/workflow-engine/src/intervention-engine-artifact-store.ts',
    'control-plane',
  ],
  ['packages/workflow-engine/src/planning-shadow-metrics.ts', 'control-plane'],
  ['packages/workflow-engine/src/recovery-trust-root-restore.ts', 'grant'],
];

test('new unified-plan authority modules have exact non-compressible roles', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
  const registry = parsePathRoleRegistry(
    JSON.parse(
      fs.readFileSync(
        path.join(repositoryRoot, 'workflow/path-roles.json'),
        'utf8',
      ),
    ),
  );

  for (const [repositoryPath, expectedRole] of EXPECTED_ROLES) {
    const resolution = resolvePathRole(registry, repositoryPath);
    assert.equal(resolution.registered, true, repositoryPath);
    if (!resolution.registered) continue;
    assert.equal(resolution.pattern, repositoryPath, repositoryPath);
    assert.equal(resolution.role, expectedRole, repositoryPath);
    assert.equal(compressionEligible(resolution), false, repositoryPath);
  }
});
