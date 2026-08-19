import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  REQUIRED_PROTECTED_CAPABILITIES,
  classifyProtectedCapabilityPaths,
  computeProtectedCapabilityEntryDigests,
  computeProtectedCapabilityEntryDigestsFromWorktree,
  loadProtectedCapabilitiesFromTrustBase,
} from '../src/protected-capabilities.ts';
import { createFixtureRepository, git, isWorkflowError } from './fixture.ts';

const MANIFEST_PATH = 'workflow/protected-capabilities.json';
const LOADER_PATH = 'packages/workflow-engine/src/protected-capabilities.ts';
const GENERATOR_PATH =
  'packages/workflow-engine/bootstrap/generate-protected-capabilities.ts';
const SOURCE_REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../../..');

function installTypedManifest(repository: string): string {
  const loader = path.join(repository, LOADER_PATH);
  fs.mkdirSync(path.dirname(loader), { recursive: true });
  fs.writeFileSync(loader, 'export const protectedLoader = true;\n');
  git(repository, ['add', LOADER_PATH]);
  git(repository, ['commit', '-m', 'Install protected capability loader']);

  const contentBase = git(repository, ['rev-parse', 'HEAD']).trim();
  const entrypoints = [LOADER_PATH];
  const dependencies = [MANIFEST_PATH];
  const digests = computeProtectedCapabilityEntryDigests(
    repository,
    contentBase,
    { entrypoints, dependencies },
  );
  const manifest = {
    kind: 'protected-capability-manifest.v1',
    schemaVersion: 1,
    manifestPath: MANIFEST_PATH,
    entries: REQUIRED_PROTECTED_CAPABILITIES.map((capability) => ({
      capability,
      entrypoints,
      dependencies,
      ...digests,
    })),
  };
  fs.writeFileSync(
    path.join(repository, MANIFEST_PATH),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  git(repository, ['add', MANIFEST_PATH]);
  git(repository, ['commit', '-m', 'Install typed capability closure']);
  return git(repository, ['rev-parse', 'HEAD']).trim();
}

test('typed protected manifest verifies trust-base content and reports affected capabilities', () => {
  const repository = createFixtureRepository();
  try {
    const trustBase = installTypedManifest(repository);
    const manifest = loadProtectedCapabilitiesFromTrustBase(
      repository,
      trustBase,
    );
    assert.equal(manifest.kind, 'protected-capability-manifest.v1');
    assert.equal(
      manifest.entries.length,
      REQUIRED_PROTECTED_CAPABILITIES.length,
    );
    assert.match(manifest.manifestDigest, /^sha256:[0-9a-f]{64}$/);

    const loaderImpact = classifyProtectedCapabilityPaths(
      repository,
      trustBase,
      [LOADER_PATH],
    );
    assert.deepEqual(loaderImpact.protectedPaths, [LOADER_PATH]);
    assert.deepEqual(loaderImpact.affectedCapabilities, [
      ...REQUIRED_PROTECTED_CAPABILITIES,
    ]);

    const ordinaryImpact = classifyProtectedCapabilityPaths(
      repository,
      trustBase,
      ['src/ordinary.ts'],
    );
    assert.deepEqual(ordinaryImpact.protectedPaths, []);
    assert.deepEqual(ordinaryImpact.affectedCapabilities, []);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('typed protected manifest fails closed when closure content changes without regenerated digests', () => {
  const repository = createFixtureRepository();
  try {
    installTypedManifest(repository);
    fs.writeFileSync(
      path.join(repository, LOADER_PATH),
      'export const protectedLoader = false;\n',
    );
    git(repository, ['add', LOADER_PATH]);
    git(repository, ['commit', '-m', 'Tamper protected loader']);
    const staleTrustBase = git(repository, ['rev-parse', 'HEAD']).trim();

    assert.throws(
      () => loadProtectedCapabilitiesFromTrustBase(repository, staleTrustBase),
      (error) =>
        isWorkflowError(error, 'PROTECTED_CAPABILITY_CLOSURE_DIGEST_MISMATCH'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('flat path manifests, incomplete capability sets, and case-fold aliases are rejected', () => {
  const repository = createFixtureRepository();
  try {
    fs.writeFileSync(
      path.join(repository, MANIFEST_PATH),
      `${JSON.stringify({ schemaVersion: 1, protectedPaths: [MANIFEST_PATH] })}\n`,
    );
    git(repository, ['add', MANIFEST_PATH]);
    git(repository, ['commit', '-m', 'Install obsolete flat manifest']);
    const flatTrustBase = git(repository, ['rev-parse', 'HEAD']).trim();
    assert.throws(
      () => loadProtectedCapabilitiesFromTrustBase(repository, flatTrustBase),
      (error) =>
        isWorkflowError(error, 'PROTECTED_CAPABILITY_MANIFEST_INVALID'),
    );

    assert.throws(
      () =>
        computeProtectedCapabilityEntryDigests(repository, flatTrustBase, {
          entrypoints: [
            'packages/workflow-engine/src/Engine.ts',
            'packages/workflow-engine/src/engine.ts',
          ],
          dependencies: [MANIFEST_PATH],
        }),
      (error) =>
        isWorkflowError(error, 'PROTECTED_CAPABILITY_MANIFEST_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('worktree closure identity matches the committed trust-base identity and detects candidate bytes', () => {
  const repository = createFixtureRepository();
  try {
    const loader = path.join(repository, LOADER_PATH);
    fs.mkdirSync(path.dirname(loader), { recursive: true });
    fs.writeFileSync(loader, 'export const protectedLoader = true;\n');
    const paths = {
      entrypoints: [LOADER_PATH],
      dependencies: [MANIFEST_PATH],
    };
    const candidate = computeProtectedCapabilityEntryDigestsFromWorktree(
      repository,
      paths,
    );

    git(repository, ['add', LOADER_PATH]);
    git(repository, ['commit', '-m', 'Commit candidate closure']);
    const committed = computeProtectedCapabilityEntryDigests(
      repository,
      git(repository, ['rev-parse', 'HEAD']).trim(),
      paths,
    );
    assert.deepEqual(candidate, committed);

    fs.writeFileSync(loader, 'export const protectedLoader = false;\n');
    assert.notDeepEqual(
      computeProtectedCapabilityEntryDigestsFromWorktree(repository, paths),
      committed,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('protected closure content uses canonical code-unit order for non-ASCII paths', () => {
  const repository = createFixtureRepository();
  const entrypoints = ['protected/Zeta.ts', 'protected/éclair.ts'];
  try {
    for (const filePath of entrypoints) {
      const absolute = path.join(repository, filePath);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(
        absolute,
        `export const path = ${JSON.stringify(filePath)};\n`,
      );
    }

    const result = computeProtectedCapabilityEntryDigestsFromWorktree(
      repository,
      { entrypoints, dependencies: [] },
    );
    const files = entrypoints.map((filePath) => {
      const content = fs.readFileSync(path.join(repository, filePath));
      return {
        path: filePath,
        mode: '100644',
        objectId: crypto
          .createHash('sha1')
          .update(Buffer.from(`blob ${content.length}\0`))
          .update(content)
          .digest('hex'),
      };
    });
    const expectedContentDigest = `sha256:${crypto
      .createHash('sha256')
      .update(
        canonicalJson({
          kind: 'protected-capability-content.v1',
          files,
        }),
      )
      .digest('hex')}`;

    assert.equal(result.contentDigest, expectedContentDigest);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('unrelated gitlinks do not invalidate a regular-file protected closure', () => {
  const repository = createFixtureRepository();
  try {
    const loader = path.join(repository, LOADER_PATH);
    fs.mkdirSync(path.dirname(loader), { recursive: true });
    fs.writeFileSync(loader, 'export const protectedLoader = true;\n');
    git(repository, ['add', LOADER_PATH]);
    git(repository, ['commit', '-m', 'Install protected loader']);
    const gitlinkTarget = git(repository, ['rev-parse', 'HEAD']).trim();
    git(repository, [
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${gitlinkTarget},vendor/example`,
    ]);
    git(repository, ['commit', '-m', 'Add unrelated gitlink']);

    assert.doesNotThrow(() =>
      computeProtectedCapabilityEntryDigests(
        repository,
        git(repository, ['rev-parse', 'HEAD']).trim(),
        {
          entrypoints: [LOADER_PATH],
          dependencies: [MANIFEST_PATH],
        },
      ),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('repository publishes the complete typed control-plane capability closure', () => {
  const value = JSON.parse(
    fs.readFileSync(path.join(SOURCE_REPOSITORY_ROOT, MANIFEST_PATH), 'utf8'),
  ) as {
    kind?: unknown;
    schemaVersion?: unknown;
    manifestPath?: unknown;
    entries?: Array<{
      capability?: unknown;
      entrypoints?: unknown;
      dependencies?: unknown;
      contentDigest?: unknown;
      closureDigest?: unknown;
    }>;
  };
  assert.equal(value.kind, 'protected-capability-manifest.v1');
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.manifestPath, MANIFEST_PATH);
  assert.deepEqual(
    value.entries?.map(({ capability }) => capability),
    [...REQUIRED_PROTECTED_CAPABILITIES],
  );
  for (const entry of value.entries ?? []) {
    assert.ok(Array.isArray(entry.entrypoints));
    assert.ok((entry.entrypoints as unknown[]).length > 0);
    assert.ok(Array.isArray(entry.dependencies));
    assert.match(String(entry.contentDigest), /^sha256:[0-9a-f]{64}$/);
    assert.match(String(entry.closureDigest), /^sha256:[0-9a-f]{64}$/);
  }

  const byCapability = new Map(
    (value.entries ?? []).map((entry) => [entry.capability, entry]),
  );
  assert.equal(
    (byCapability.get('audit.append')?.entrypoints as unknown[]).includes(
      'packages/workflow-engine/src/authority-audit-ledger.ts',
    ),
    true,
  );
  assert.equal(
    (byCapability.get('apply.journal')?.entrypoints as unknown[]).includes(
      'packages/workflow-engine/src/application/control-plane/maintainer-recovery.ts',
    ),
    true,
  );
  assert.equal(
    (byCapability.get('apply.journal')?.entrypoints as unknown[]).includes(
      'packages/workflow-engine/src/application/control-plane/authority-plan.ts',
    ),
    true,
  );
  assert.equal(
    (
      byCapability.get('authorization.verify')?.entrypoints as unknown[]
    ).includes('packages/workflow-engine/src/pre-merge-assurance-git.ts'),
    true,
  );
  assert.equal(
    (
      byCapability.get('authorization.verify')?.dependencies as unknown[]
    ).includes(
      'packages/workflow-engine/src/modules/assurance/pre-merge-assurance.ts',
    ),
    true,
  );
  assert.equal(
    (
      byCapability.get('control-plane.update')?.entrypoints as unknown[]
    ).includes(
      'packages/workflow-engine/src/application/control-plane/intervention-control-updater.ts',
    ),
    true,
  );
  assert.equal(
    (
      byCapability.get('control-plane.update')?.entrypoints as unknown[]
    ).includes(GENERATOR_PATH),
    true,
  );
  assert.equal(
    (byCapability.get('policy.classify')?.entrypoints as unknown[]).includes(
      GENERATOR_PATH,
    ),
    true,
  );
});

test('repository protected capability manifest is generator-current', () => {
  const result = runProtectedCapabilityGenerator(
    path.join(SOURCE_REPOSITORY_ROOT, GENERATOR_PATH),
    SOURCE_REPOSITORY_ROOT,
    '--check',
  );
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

test('repository-owned protected capability generator writes, checks, and preserves the manifest-self sentinel', () => {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'protected-capability-generator-'),
  );
  const generator = path.join(SOURCE_REPOSITORY_ROOT, GENERATOR_PATH);
  const protectedDependency = 'src/protected.ts';
  try {
    git(repository, ['init', '--quiet']);
    git(repository, ['config', 'user.name', 'Workflow Test']);
    git(repository, ['config', 'user.email', 'workflow@example.test']);
    for (const [filePath, content] of [
      [LOADER_PATH, 'export const protectedLoader = true;\n'],
      [protectedDependency, 'export const protectedValue = true;\n'],
    ] as const) {
      const absolute = path.join(repository, filePath);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, content);
    }
    const staleDigest = `sha256:${'0'.repeat(64)}`;
    const manifest = {
      kind: 'protected-capability-manifest.v1',
      schemaVersion: 1,
      manifestPath: MANIFEST_PATH,
      entries: REQUIRED_PROTECTED_CAPABILITIES.map((capability) => ({
        capability,
        entrypoints: [LOADER_PATH],
        dependencies: [protectedDependency, MANIFEST_PATH],
        contentDigest: staleDigest,
        closureDigest: staleDigest,
      })),
    };
    const manifestAbsolute = path.join(repository, MANIFEST_PATH);
    fs.mkdirSync(path.dirname(manifestAbsolute), { recursive: true });
    fs.writeFileSync(
      manifestAbsolute,
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    git(repository, ['add', '.']);

    const staleCheck = runProtectedCapabilityGenerator(
      generator,
      repository,
      '--check',
    );
    assert.notEqual(staleCheck.status, 0);
    assert.match(`${staleCheck.stdout}${staleCheck.stderr}`, /stale/i);

    const write = runProtectedCapabilityGenerator(
      generator,
      repository,
      '--write',
    );
    assert.equal(write.status, 0, write.stderr);
    const firstProjection = fs.readFileSync(manifestAbsolute, 'utf8');
    const projected = JSON.parse(firstProjection) as {
      entries: Array<{
        capability: string;
        entrypoints: string[];
        dependencies: string[];
        contentDigest: string;
        closureDigest: string;
      }>;
    };
    assert.deepEqual(Object.keys(projected), [
      'kind',
      'schemaVersion',
      'manifestPath',
      'entries',
    ]);
    assert.deepEqual(
      projected.entries.map(({ capability }) => capability),
      [...REQUIRED_PROTECTED_CAPABILITIES],
    );
    for (const entry of projected.entries) {
      assert.deepEqual(entry.entrypoints, [LOADER_PATH]);
      assert.deepEqual(entry.dependencies, [
        protectedDependency,
        MANIFEST_PATH,
      ]);
      assert.notEqual(entry.contentDigest, staleDigest);
      assert.notEqual(entry.closureDigest, staleDigest);
    }
    const currentCheck = runProtectedCapabilityGenerator(
      generator,
      repository,
      '--check',
    );
    assert.equal(currentCheck.status, 0, currentCheck.stderr);
    git(repository, ['add', '.']);
    git(repository, ['commit', '--quiet', '-m', 'Generate protected closure']);
    const trustBase = git(repository, ['rev-parse', 'HEAD']).trim();
    assert.equal(
      loadProtectedCapabilitiesFromTrustBase(repository, trustBase).entries
        .length,
      REQUIRED_PROTECTED_CAPABILITIES.length,
    );

    for (const entry of projected.entries) {
      entry.contentDigest = staleDigest;
      entry.closureDigest = staleDigest;
    }
    fs.writeFileSync(
      manifestAbsolute,
      `${JSON.stringify(projected, null, 2)}\n`,
    );
    const rewrite = runProtectedCapabilityGenerator(
      generator,
      repository,
      '--write',
    );
    assert.equal(rewrite.status, 0, rewrite.stderr);
    assert.equal(fs.readFileSync(manifestAbsolute, 'utf8'), firstProjection);

    fs.writeFileSync(
      path.join(repository, protectedDependency),
      'export const protectedValue = false;\n',
    );
    const changedClosure = runProtectedCapabilityGenerator(
      generator,
      repository,
      '--check',
    );
    assert.notEqual(changedClosure.status, 0);
    assert.match(`${changedClosure.stdout}${changedClosure.stderr}`, /stale/i);

    const invalidMode = runProtectedCapabilityGenerator(
      generator,
      repository,
      '--unknown',
    );
    assert.notEqual(invalidMode.status, 0);
    assert.match(
      `${invalidMode.stdout}${invalidMode.stderr}`,
      /--check\|--write/,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function runProtectedCapabilityGenerator(
  generator: string,
  repository: string,
  mode: '--check' | '--write' | '--unknown',
) {
  return spawnSync(
    process.execPath,
    ['--experimental-strip-types', generator, mode],
    { cwd: repository, encoding: 'utf8' },
  );
}
