import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const WORKFLOW_ENGINE_ROOT = path.resolve(import.meta.dirname, '..');
const V1_RENDERER_FIXTURE_DIGEST =
  '191e605cedd3b4d52e1367f416a43664d3e4d9cb326b8d4709753149d8b578c8';

type Digest = `sha256:${string}`;

interface ClosureFile {
  path: string;
  repositoryPath: string;
  mode: '100644' | '100755';
  digest: Digest;
  bytes: Buffer;
}

interface TestSurface {
  assertBuiltInClosureTrackedAtProvenance(
    worktreeRoot: string,
    provenance: { headOid: string },
    closure: {
      manifest: Record<string, unknown>;
      manifestBytes: Buffer;
      manifestDigest: Digest;
      files: ClosureFile[];
    },
  ): void;
  verifiedBuiltInEngineClosure(packageRoot: string): {
    manifest: Record<string, unknown>;
    manifestBytes: Buffer;
    manifestDigest: Digest;
    files: ClosureFile[];
  };
  builtInSupervisorExecutableSource(
    builtInClosureDigest: Digest,
    controlPlaneClosureDigest: Digest,
    manifest: Record<string, unknown>,
    bootstrapRuntimeFiles: Array<{
      path: string;
      mode: '100644' | '100755';
      digest: Digest;
      bytes: Buffer;
    }>,
  ): string;
  createBuiltInControlPlaneEngineArtifact(
    sourceDigest: Digest,
    controlPlaneClosureDigest: Digest,
    executableDigest: Digest,
  ): Record<string, unknown> & { artifactId: Digest };
  bootstrapPaths(storageRoot: string): { artifacts: string };
  materializeBuiltInClosure(
    paths: { artifacts: string },
    closure: {
      manifest: Record<string, unknown>;
      manifestBytes: Buffer;
      manifestDigest: Digest;
      files: ClosureFile[];
    },
    protectedManifest: {
      payload: Record<string, unknown>;
      manifestDigest: Digest;
      bootstrapRuntimeFiles: Array<{
        path: string;
        mode: '100644' | '100755';
        digest: Digest;
        bytes: Buffer;
      }>;
    },
    artifact: Record<string, unknown> & { artifactId: Digest },
    executableBytes: Buffer,
  ): void;
}

test('V2 control-plane closure maps workspace sources, materializes bare imports, and fails closed', async () => {
  const fixture = createWorkspaceClosureFixture();
  try {
    const surface = await loadInstrumentedControlPlane(fixture.root);
    assertV1RendererBytesUnchanged(surface, fixture.bootstrapRuntimeFiles);

    const closure = surface.verifiedBuiltInEngineClosure(
      fixture.workflowEngineRoot,
    );
    assert.equal(closure.manifest.kind, 'built-in-engine-closure-manifest.v2');
    assert.deepEqual(
      closure.files.map((entry) => [entry.path, entry.repositoryPath]),
      [
        [
          'node_modules/@jigwright/core/package.json',
          'packages/core/package.json',
        ],
        [
          'node_modules/@jigwright/core/src/value.ts',
          'packages/core/src/value.ts',
        ],
        ['package.json', 'packages/workflow-engine/package.json'],
        ['src/cli.ts', 'packages/workflow-engine/src/cli.ts'],
      ],
    );
    const headOid = commitFixture(fixture.root);
    assert.doesNotThrow(() =>
      surface.assertBuiltInClosureTrackedAtProvenance(
        fixture.root,
        { headOid },
        closure,
      ),
    );

    const unlistedSource = path.join(
      fixture.root,
      'packages/core/src/extra.ts',
    );
    fs.writeFileSync(unlistedSource, 'export const extra = true;\n', {
      mode: 0o644,
    });
    assert.throws(
      () => surface.verifiedBuiltInEngineClosure(fixture.workflowEngineRoot),
      hasCode('WORKFLOW_BUILT_IN_ENGINE_CLOSURE_MISMATCH'),
    );
    fs.rmSync(unlistedSource);

    const controlPlaneClosureDigest = digest('fixture-control-plane-closure');
    const executableBytes = Buffer.from(
      surface.builtInSupervisorExecutableSource(
        closure.manifestDigest,
        controlPlaneClosureDigest,
        closure.manifest,
        fixture.bootstrapRuntimeFiles,
      ),
    );
    const artifact = surface.createBuiltInControlPlaneEngineArtifact(
      closure.manifestDigest,
      controlPlaneClosureDigest,
      digest(executableBytes),
    );
    const stateRoot = path.join(fixture.root, 'private-state');
    fs.mkdirSync(stateRoot, { mode: 0o700 });
    const paths = surface.bootstrapPaths(stateRoot);
    surface.materializeBuiltInClosure(
      paths,
      closure,
      {
        payload: {},
        manifestDigest: controlPlaneClosureDigest,
        bootstrapRuntimeFiles: fixture.bootstrapRuntimeFiles,
      },
      artifact,
      executableBytes,
    );

    const artifactRoot = path.join(
      paths.artifacts,
      artifact.artifactId.slice('sha256:'.length),
    );
    const executable = path.join(artifactRoot, 'engine');
    const launched = spawnSync(executable, ['fixture-argument'], {
      cwd: artifactRoot,
      encoding: 'utf8',
    });
    assert.equal(launched.status, 0, launched.stderr);
    assert.deepEqual(JSON.parse(launched.stdout), {
      kind: 'workspace-closure-v2-fixture',
      value: 'core-value',
      argv: ['fixture-argument'],
    });

    const materializedCore = path.join(
      artifactRoot,
      'closure/node_modules/@jigwright/core/src/value.ts',
    );
    fs.writeFileSync(materializedCore, 'export const value = "tampered";\n');
    const tampered = spawnSync(executable, [], {
      cwd: artifactRoot,
      encoding: 'utf8',
    });
    assert.equal(tampered.status, 13);
    assert.match(tampered.stderr, /CONTROL_PLANE_BOOTSTRAP_ARTIFACT_MISMATCH/);

    fs.writeFileSync(materializedCore, fixture.coreSourceBytes);
    fs.writeFileSync(
      path.join(
        artifactRoot,
        'closure/node_modules/@jigwright/core/src/unlisted.ts',
      ),
      'export const unlisted = true;\n',
      { mode: 0o600 },
    );
    const unlisted = spawnSync(executable, [], {
      cwd: artifactRoot,
      encoding: 'utf8',
    });
    assert.equal(unlisted.status, 13);
    assert.match(unlisted.stderr, /complete closure inventory/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

function createWorkspaceClosureFixture(): {
  root: string;
  workflowEngineRoot: string;
  coreSourceBytes: string;
  bootstrapRuntimeFiles: Array<{
    path: string;
    mode: '100644';
    digest: Digest;
    bytes: Buffer;
  }>;
} {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'built-in-workspace-closure-v2-')),
  );
  const workflowEngineRoot = path.join(root, 'packages/workflow-engine');
  const workflowBootstrap = path.join(workflowEngineRoot, 'bootstrap');
  const workflowSource = path.join(workflowEngineRoot, 'src');
  const coreRoot = path.join(root, 'packages/core');
  const coreSource = path.join(coreRoot, 'src');
  fs.mkdirSync(workflowBootstrap, { recursive: true });
  fs.mkdirSync(workflowSource, { recursive: true });
  fs.mkdirSync(coreSource, { recursive: true });

  const workflowPackageBytes = `${JSON.stringify(
    {
      name: '@expense/workflow-engine',
      private: true,
      type: 'module',
      dependencies: { '@jigwright/core': 'workspace:*' },
    },
    null,
    2,
  )}\n`;
  const workflowSourceBytes = [
    "import { value } from '@jigwright/core/value';",
    'process.stdout.write(JSON.stringify({',
    "  kind: 'workspace-closure-v2-fixture',",
    '  value,',
    '  argv: process.argv.slice(2),',
    "}) + '\\n');",
    '',
  ].join('\n');
  const corePackageBytes = `${JSON.stringify(
    {
      name: '@jigwright/core',
      private: true,
      type: 'module',
      exports: { './value': './src/value.ts' },
    },
    null,
    2,
  )}\n`;
  const coreSourceBytes = "export const value = 'core-value';\n";
  fs.writeFileSync(
    path.join(workflowEngineRoot, 'package.json'),
    workflowPackageBytes,
    { mode: 0o644 },
  );
  fs.writeFileSync(path.join(workflowSource, 'cli.ts'), workflowSourceBytes, {
    mode: 0o644,
  });
  fs.writeFileSync(path.join(coreRoot, 'package.json'), corePackageBytes, {
    mode: 0o644,
  });
  fs.writeFileSync(path.join(coreSource, 'value.ts'), coreSourceBytes, {
    mode: 0o644,
  });

  const packages = [
    {
      name: '@expense/workflow-engine',
      sourceRoot: 'packages/workflow-engine',
      closureRoot: '.',
    },
    {
      name: '@jigwright/core',
      sourceRoot: 'packages/core',
      closureRoot: 'node_modules/@jigwright/core',
    },
  ];
  const files = [
    {
      path: 'node_modules/@jigwright/core/package.json',
      mode: '100644',
      digest: digest(corePackageBytes),
    },
    {
      path: 'node_modules/@jigwright/core/src/value.ts',
      mode: '100644',
      digest: digest(coreSourceBytes),
    },
    {
      path: 'package.json',
      mode: '100644',
      digest: digest(workflowPackageBytes),
    },
    {
      path: 'src/cli.ts',
      mode: '100644',
      digest: digest(workflowSourceBytes),
    },
  ];
  const manifest = {
    kind: 'built-in-engine-closure-manifest.v2',
    entrypoint: 'src/cli.ts',
    scope: 'workspace-runtime-source-closure',
    packages,
    files,
  };
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(
    path.join(workflowBootstrap, 'built-in-engine-closure.json'),
    manifestBytes,
    { mode: 0o644 },
  );
  fs.writeFileSync(
    path.join(workflowBootstrap, 'built-in-engine-closure-pin.ts'),
    [
      '// Fixture pin.',
      'export const BUILT_IN_ENGINE_CLOSURE_MANIFEST_DIGEST =',
      `  '${digest(manifestBytes)}' as const;`,
      '',
    ].join('\n'),
    { mode: 0o644 },
  );
  fs.copyFileSync(
    path.join(WORKFLOW_ENGINE_ROOT, 'bootstrap/canonical-json.ts'),
    path.join(workflowBootstrap, 'canonical-json.ts'),
  );
  const productionSource = fs.readFileSync(
    path.join(WORKFLOW_ENGINE_ROOT, 'bootstrap/control-plane-trust.ts'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(workflowBootstrap, 'control-plane-trust.ts'),
    `${productionSource}\nexport { assertBuiltInClosureTrackedAtProvenance, bootstrapPaths, builtInSupervisorExecutableSource, createBuiltInControlPlaneEngineArtifact, materializeBuiltInClosure, verifiedBuiltInEngineClosure };\n`,
    { mode: 0o644 },
  );

  const bootstrapRuntimeFiles = [
    'built-in-engine-closure-pin.ts',
    'canonical-json.ts',
    'control-plane-trust.ts',
  ].map((name) => {
    const bytes = fs.readFileSync(path.join(workflowBootstrap, name));
    return {
      path: `bootstrap/${name}`,
      mode: '100644' as const,
      digest: digest(bytes),
      bytes,
    };
  });
  return {
    root,
    workflowEngineRoot,
    coreSourceBytes,
    bootstrapRuntimeFiles,
  };
}

function commitFixture(repositoryRoot: string): string {
  for (const args of [
    ['init', '--initial-branch=main'],
    ['config', 'user.name', 'Fixture'],
    ['config', 'user.email', 'fixture@example.invalid'],
    ['add', '.'],
    ['commit', '-m', 'Create workspace closure fixture'],
  ]) {
    const result = spawnSync('/usr/bin/git', args, {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
  }
  const head = spawnSync('/usr/bin/git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  assert.equal(head.status, 0, head.stderr);
  return head.stdout.trim();
}

async function loadInstrumentedControlPlane(
  repositoryRoot: string,
): Promise<TestSurface> {
  const modulePath = path.join(
    repositoryRoot,
    'packages/workflow-engine/bootstrap/control-plane-trust.ts',
  );
  return (await import(
    `${pathToFileURL(modulePath).href}?fixture=${crypto.randomUUID()}`
  )) as unknown as TestSurface;
}

function assertV1RendererBytesUnchanged(
  surface: TestSurface,
  bootstrapRuntimeFiles: Array<{
    path: string;
    mode: '100644';
    digest: Digest;
    bytes: Buffer;
  }>,
): void {
  const descriptors = bootstrapRuntimeFiles.map((entry, index) => ({
    ...entry,
    digest: `sha256:${String(index + 3).repeat(64)}` as Digest,
  }));
  const rendered = surface.builtInSupervisorExecutableSource(
    `sha256:${'1'.repeat(64)}`,
    `sha256:${'2'.repeat(64)}`,
    {
      kind: 'built-in-engine-closure-manifest.v1',
      entrypoint: 'src/cli.ts',
      scope: 'package-json-and-all-src-typescript',
      files: [],
    },
    descriptors,
  );
  assert.equal(
    crypto.createHash('sha256').update(rendered).digest('hex'),
    V1_RENDERER_FIXTURE_DIGEST,
  );
}

function digest(value: string | Buffer): Digest {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function hasCode(expected: string): (error: unknown) => boolean {
  return (error) =>
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === expected;
}
