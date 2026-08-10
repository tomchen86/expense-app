import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  buildMaintainerPatchManifest,
  canonicalPatchManifest,
  classifyFileRole,
  parseCapabilityProfile,
  parsePatchManifest,
  verifyPatchManifestAgainstWorktree,
} from '../src/maintainer-manifest.ts';
import { createFixtureRepository, git, isWorkflowError } from './fixture.ts';

const PROFILE = {
  id: 'workflow-engine-bootstrap',
  version: 1,
  authorityClass: 'ordinary',
  implementationPaths: ['packages/workflow-engine/src/**'],
  evidencePaths: ['packages/workflow-engine/test/**'],
  policyPaths: ['workflow/maintainer-policy.json'],
  verificationInfrastructurePaths: [
    '.github/workflows/**',
    'workflow/checks.json',
  ],
  // The grant verifier itself must never be reachable from an ordinary
  // profile, even though it sits under the implementation root.
  forbiddenPaths: ['packages/workflow-engine/src/maintainer-grant.ts'],
  constraints: {
    evidenceOnlyGrantForbidden: true,
    samePackageRequired: true,
    evidenceAdditionsAllowed: false,
    maximumFiles: 12,
  },
  requiredChecks: ['fixture'],
  checkDependencies: {
    fixture: ['harness-engine', 'runner', 'source-tree'],
  },
};

function seedProfileRepository(): string {
  const repository = createFixtureRepository();
  fs.mkdirSync(path.join(repository, 'packages/workflow-engine/src'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(repository, 'packages/workflow-engine/test'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(repository, 'packages/workflow-engine/src/limits.ts'),
    'export const LIMIT = 1;\n',
  );
  fs.writeFileSync(
    path.join(repository, 'packages/workflow-engine/test/limits.test.ts'),
    'export const EXPECTED = 1;\n',
  );
  git(repository, ['add', '-A']);
  git(repository, ['commit', '-m', 'Seed profile fixture files']);
  return repository;
}

function trustBase(repository: string): string {
  return git(repository, ['rev-parse', 'HEAD']).trim();
}

function bindManifestDigest<T extends { patchDigest: string }>(manifest: T): T {
  const body = { ...manifest, patchDigest: '' };
  return {
    ...body,
    patchDigest: crypto
      .createHash('sha256')
      .update(canonicalPatchManifest(body as never))
      .digest('hex'),
  };
}

test('capability profile rejects globs that are not exact roots or forbidden wins', () => {
  const profile = parseCapabilityProfile(PROFILE);
  assert.equal(profile.id, 'workflow-engine-bootstrap');
  assert.equal(profile.authorityClass, 'ordinary');
  assert.deepEqual(profile.checkDependencies.fixture, [
    'harness-engine',
    'runner',
    'source-tree',
  ]);
  assert.throws(
    () => parseCapabilityProfile({ ...PROFILE, version: 0 }),
    (error) => isWorkflowError(error, 'MAINTAINER_PROFILE_INVALID'),
  );
  assert.throws(
    () => parseCapabilityProfile({ ...PROFILE, authorityClass: 'unbounded' }),
    (error) => isWorkflowError(error, 'MAINTAINER_PROFILE_INVALID'),
  );
  assert.throws(
    () => parseCapabilityProfile({ ...PROFILE, implementationPaths: [] }),
    (error) => isWorkflowError(error, 'MAINTAINER_PROFILE_INVALID'),
  );
  assert.throws(
    () =>
      parseCapabilityProfile({
        ...PROFILE,
        forbiddenPaths: ['packages/workflow-engine/src/**'],
        // A forbidden root that also appears as an implementation root is a
        // contradiction the profile must reject at load time.
      }),
    (error) => isWorkflowError(error, 'MAINTAINER_PROFILE_INVALID'),
  );
  assert.throws(
    () => parseCapabilityProfile({ ...PROFILE, unknownField: true }),
    (error) => isWorkflowError(error, 'MAINTAINER_PROFILE_INVALID'),
  );
  assert.throws(
    () =>
      parseCapabilityProfile({
        ...PROFILE,
        constraints: { ...PROFILE.constraints, unknownField: true },
      }),
    (error) => isWorkflowError(error, 'MAINTAINER_PROFILE_INVALID'),
  );
  assert.throws(
    () =>
      parseCapabilityProfile({
        ...PROFILE,
        requiredChecks: ['z-check', 'a-check'],
      }),
    (error) => isWorkflowError(error, 'MAINTAINER_PROFILE_INVALID'),
  );
  assert.throws(
    () =>
      parseCapabilityProfile({
        ...PROFILE,
        checkDependencies: { other: ['source-tree'] },
      }),
    (error) => isWorkflowError(error, 'MAINTAINER_PROFILE_INVALID'),
  );
  assert.throws(
    () =>
      parseCapabilityProfile({
        ...PROFILE,
        implementationPaths: ['packages/**/src'],
      }),
    (error) => isWorkflowError(error, 'MAINTAINER_PROFILE_INVALID'),
  );
  assert.throws(
    () =>
      parseCapabilityProfile({
        ...PROFILE,
        implementationPaths: [
          'packages/workflow-engine/SRC/**',
          'packages/workflow-engine/src/**',
        ],
      }),
    (error) => isWorkflowError(error, 'MAINTAINER_PROFILE_INVALID'),
  );
  assert.throws(
    () =>
      parseCapabilityProfile({
        ...PROFILE,
        implementationPaths: ['packages/workflow-engine/cafe\u0301/**'],
      }),
    (error) => isWorkflowError(error, 'MAINTAINER_PROFILE_INVALID'),
  );
});

test('external-state freshness policy exactly covers external checks', () => {
  const externalProfile = {
    ...PROFILE,
    checkDependencies: {
      fixture: ['external-state', 'runner'],
    },
    externalStateFreshness: {
      fixture: { maxAgeMs: 60_000 },
    },
  };
  const parsed = parseCapabilityProfile(externalProfile);
  assert.deepEqual(parsed.externalStateFreshness, {
    fixture: { maxAgeMs: 60_000 },
  });
  assert.throws(
    () =>
      parseCapabilityProfile({
        ...externalProfile,
        externalStateFreshness: undefined,
      }),
    (error) => isWorkflowError(error, 'MAINTAINER_PROFILE_INVALID'),
  );
  assert.throws(
    () =>
      parseCapabilityProfile({
        ...externalProfile,
        externalStateFreshness: {
          fixture: { maxAgeMs: 0 },
        },
      }),
    (error) => isWorkflowError(error, 'MAINTAINER_PROFILE_INVALID'),
  );
  assert.throws(
    () =>
      parseCapabilityProfile({
        ...PROFILE,
        externalStateFreshness: {
          fixture: { maxAgeMs: 60_000 },
        },
      }),
    (error) => isWorkflowError(error, 'MAINTAINER_PROFILE_INVALID'),
  );
});

test('file roles classify by profile roots with forbidden and policy precedence', () => {
  const profile = parseCapabilityProfile(PROFILE);
  assert.equal(
    classifyFileRole(profile, 'packages/workflow-engine/src/limits.ts'),
    'implementation',
  );
  assert.equal(
    classifyFileRole(profile, 'packages/workflow-engine/test/limits.test.ts'),
    'evidence',
  );
  assert.equal(
    classifyFileRole(profile, 'workflow/maintainer-policy.json'),
    'policy',
  );
  assert.equal(
    classifyFileRole(profile, 'workflow/checks.json'),
    'verification-infrastructure',
  );
  assert.equal(classifyFileRole(profile, 'docs/readme.md'), undefined);
  assert.equal(
    classifyFileRole(
      profile,
      'packages/workflow-engine/src/maintainer-grant.ts',
    ),
    'forbidden',
  );
});

test('manifest binds exact before and after identity for each changed file', () => {
  const repository = seedProfileRepository();
  try {
    const base = trustBase(repository);
    const implementationPath = path.join(
      repository,
      'packages/workflow-engine/src/limits.ts',
    );
    const evidencePath = path.join(
      repository,
      'packages/workflow-engine/test/limits.test.ts',
    );
    fs.writeFileSync(implementationPath, 'export const LIMIT = 2;\n');
    fs.writeFileSync(evidencePath, 'export const EXPECTED = 2;\n');

    const manifest = buildMaintainerPatchManifest(repository, {
      profile: parseCapabilityProfile(PROFILE),
      trustBaseCommit: base,
      policyDigest: 'a'.repeat(64),
    });

    assert.equal(manifest.schema, 'maintainer-patch-manifest.v2');
    assert.equal(manifest.profile, 'workflow-engine-bootstrap');
    assert.equal(manifest.trustBaseCommit, base);
    assert.deepEqual(
      manifest.files.map(({ path: filePath, role, operation }) => ({
        filePath,
        role,
        operation,
      })),
      [
        {
          filePath: 'packages/workflow-engine/src/limits.ts',
          role: 'implementation',
          operation: 'modify',
        },
        {
          filePath: 'packages/workflow-engine/test/limits.test.ts',
          role: 'evidence',
          operation: 'modify',
        },
      ],
    );
    for (const file of manifest.files) {
      assert.match(file.beforeBlobOid ?? '', /^[0-9a-f]{40}$/);
      assert.match(file.afterSha256 ?? '', /^[0-9a-f]{64}$/);
      assert.equal(file.beforeMode, '100644');
      assert.equal(file.afterMode, '100644');
    }
    assert.match(manifest.patchDigest, /^[0-9a-f]{64}$/);
    // Canonical serialization must be deterministic and stable across rebuilds.
    const rebuilt = buildMaintainerPatchManifest(repository, {
      profile: parseCapabilityProfile(PROFILE),
      trustBaseCommit: base,
      policyDigest: 'a'.repeat(64),
    });
    assert.equal(
      canonicalPatchManifest(rebuilt),
      canonicalPatchManifest(manifest),
    );
    assert.equal(rebuilt.patchDigest, manifest.patchDigest);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('manifest rejects Unicode-normalization and case-folding path aliases', () => {
  const repository = seedProfileRepository();
  try {
    const base = trustBase(repository);
    fs.writeFileSync(
      path.join(repository, 'packages/workflow-engine/src/limits.ts'),
      'export const LIMIT = 2;\n',
    );
    const valid = buildMaintainerPatchManifest(repository, {
      profile: parseCapabilityProfile(PROFILE),
      trustBaseCommit: base,
      policyDigest: 'a'.repeat(64),
    });
    const file = valid.files[0]!;
    const decomposed = bindManifestDigest({
      ...valid,
      files: [
        {
          ...file,
          path: 'packages/workflow-engine/src/cafe\u0301.ts',
        },
      ],
    });
    assert.throws(
      () => parsePatchManifest(decomposed),
      (error) => isWorkflowError(error, 'MAINTAINER_PATCH_INVALID'),
    );

    const caseAliases = bindManifestDigest({
      ...valid,
      files: [
        { ...file, path: 'packages/workflow-engine/src/Limit.ts' },
        { ...file, path: 'packages/workflow-engine/src/limit.ts' },
      ],
    });
    assert.throws(
      () => parsePatchManifest(caseAliases),
      (error) => isWorkflowError(error, 'MAINTAINER_PATCH_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('evidence may not travel without implementation in the same package', () => {
  const repository = seedProfileRepository();
  try {
    const base = trustBase(repository);
    fs.writeFileSync(
      path.join(repository, 'packages/workflow-engine/test/limits.test.ts'),
      'export const EXPECTED = 3;\n',
    );
    assert.throws(
      () =>
        buildMaintainerPatchManifest(repository, {
          profile: parseCapabilityProfile(PROFILE),
          trustBaseCommit: base,
          policyDigest: 'a'.repeat(64),
        }),
      (error) => isWorkflowError(error, 'MAINTAINER_EVIDENCE_UNSUPPORTED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('manifest rejects untracked evidence additions unless the profile allows them', () => {
  const repository = seedProfileRepository();
  try {
    const base = trustBase(repository);
    fs.writeFileSync(
      path.join(repository, 'packages/workflow-engine/src/limits.ts'),
      'export const LIMIT = 4;\n',
    );
    fs.writeFileSync(
      path.join(repository, 'packages/workflow-engine/test/new.test.ts'),
      'export const NEW = true;\n',
    );
    assert.throws(
      () =>
        buildMaintainerPatchManifest(repository, {
          profile: parseCapabilityProfile(PROFILE),
          trustBaseCommit: base,
          policyDigest: 'a'.repeat(64),
        }),
      (error) => isWorkflowError(error, 'MAINTAINER_EVIDENCE_UNSUPPORTED'),
    );

    const permissive = parseCapabilityProfile({
      ...PROFILE,
      constraints: { ...PROFILE.constraints, evidenceAdditionsAllowed: true },
    });
    const manifest = buildMaintainerPatchManifest(repository, {
      profile: permissive,
      trustBaseCommit: base,
      policyDigest: 'a'.repeat(64),
    });
    const added = manifest.files.find(
      (file) => file.path === 'packages/workflow-engine/test/new.test.ts',
    );
    assert.equal(added?.operation, 'add');
    assert.equal(added?.beforeBlobOid, null);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('manifest rejects executable evidence even when the candidate deletes it', () => {
  const repository = seedProfileRepository();
  try {
    const evidencePath = path.join(
      repository,
      'packages/workflow-engine/test/limits.test.ts',
    );
    fs.chmodSync(evidencePath, 0o755);
    git(repository, ['add', '-A']);
    git(repository, ['commit', '-m', 'Make fixture evidence executable']);
    const base = trustBase(repository);
    fs.writeFileSync(
      path.join(repository, 'packages/workflow-engine/src/limits.ts'),
      'export const LIMIT = 4;\n',
    );
    fs.unlinkSync(evidencePath);

    assert.throws(
      () =>
        buildMaintainerPatchManifest(repository, {
          profile: parseCapabilityProfile(PROFILE),
          trustBaseCommit: base,
          policyDigest: 'a'.repeat(64),
        }),
      (error) => isWorkflowError(error, 'MAINTAINER_PATH_UNSAFE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('manifest rejects paths outside profile roots and forbidden paths', () => {
  const repository = seedProfileRepository();
  try {
    const base = trustBase(repository);
    fs.writeFileSync(
      path.join(repository, 'packages/workflow-engine/src/limits.ts'),
      'export const LIMIT = 5;\n',
    );
    fs.writeFileSync(path.join(repository, 'src/.gitkeep'), 'unexpected\n');
    assert.throws(
      () =>
        buildMaintainerPatchManifest(repository, {
          profile: parseCapabilityProfile(PROFILE),
          trustBaseCommit: base,
          policyDigest: 'a'.repeat(64),
        }),
      (error) => isWorkflowError(error, 'MAINTAINER_PATH_UNCLASSIFIED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('manifest enforces the profile file ceiling', () => {
  const repository = seedProfileRepository();
  try {
    const base = trustBase(repository);
    fs.writeFileSync(
      path.join(repository, 'packages/workflow-engine/src/limits.ts'),
      'export const LIMIT = 6;\n',
    );
    fs.writeFileSync(
      path.join(repository, 'packages/workflow-engine/test/limits.test.ts'),
      'export const EXPECTED = 6;\n',
    );
    const tiny = parseCapabilityProfile({
      ...PROFILE,
      constraints: { ...PROFILE.constraints, maximumFiles: 1 },
    });
    assert.throws(
      () =>
        buildMaintainerPatchManifest(repository, {
          profile: tiny,
          trustBaseCommit: base,
          policyDigest: 'a'.repeat(64),
        }),
      (error) => isWorkflowError(error, 'MAINTAINER_PATCH_TOO_LARGE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('verification rejects drift in content, extra files, and missing files', () => {
  const repository = seedProfileRepository();
  try {
    const base = trustBase(repository);
    const implementationPath = path.join(
      repository,
      'packages/workflow-engine/src/limits.ts',
    );
    const evidencePath = path.join(
      repository,
      'packages/workflow-engine/test/limits.test.ts',
    );
    fs.writeFileSync(implementationPath, 'export const LIMIT = 7;\n');
    fs.writeFileSync(evidencePath, 'export const EXPECTED = 7;\n');
    const profile = parseCapabilityProfile(PROFILE);
    const manifest = buildMaintainerPatchManifest(repository, {
      profile,
      trustBaseCommit: base,
      policyDigest: 'a'.repeat(64),
    });

    // Exact match verifies.
    verifyPatchManifestAgainstWorktree(repository, manifest);

    // Byte drift in an already-listed file is rejected.
    fs.writeFileSync(implementationPath, 'export const LIMIT = 8;\n');
    assert.throws(
      () => verifyPatchManifestAgainstWorktree(repository, manifest),
      (error) => isWorkflowError(error, 'MAINTAINER_PATCH_DRIFT'),
    );
    fs.writeFileSync(implementationPath, 'export const LIMIT = 7;\n');
    verifyPatchManifestAgainstWorktree(repository, manifest);

    // An extra changed file outside the manifest is rejected.
    fs.writeFileSync(
      path.join(repository, 'packages/workflow-engine/src/extra.ts'),
      'export const EXTRA = true;\n',
    );
    assert.throws(
      () => verifyPatchManifestAgainstWorktree(repository, manifest),
      (error) => isWorkflowError(error, 'MAINTAINER_PATCH_DRIFT'),
    );
    fs.rmSync(path.join(repository, 'packages/workflow-engine/src/extra.ts'));

    // A manifest file reverted to its trust-base content is also drift.
    fs.writeFileSync(evidencePath, 'export const EXPECTED = 1;\n');
    assert.throws(
      () => verifyPatchManifestAgainstWorktree(repository, manifest),
      (error) => isWorkflowError(error, 'MAINTAINER_PATCH_DRIFT'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
