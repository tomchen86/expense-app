import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  OPENSPEC_ASSET_MANIFEST_PATH,
  applyOpenSpecPlanningAssetOverlay,
  verifyOpenSpecPlanningAssetContent,
} from '../src/openspec-planning-asset-contract.ts';
import {
  checkOpenSpecPlanningAssets,
  generateOpenSpecPlanningAssets,
} from '../src/openspec-planning-assets.ts';
import {
  installFakeOpenSpec,
  isWorkflowError,
  sourceRepositoryRoot,
} from './fixture.ts';

const FIXTURE_ROOT = path.join(
  sourceRepositoryRoot,
  'packages/workflow-engine/test/fixtures/openspec-assets',
);
const EXPECTED_ASSET_PATHS = [
  '.codex/skills/openspec-explore/SKILL.md',
  '.codex/skills/openspec-propose/SKILL.md',
  '.claude/skills/openspec-explore/SKILL.md',
  '.claude/skills/openspec-propose/SKILL.md',
  '.agents/skills/openspec-explore/SKILL.md',
  '.agents/skills/openspec-propose/SKILL.md',
  'workflow/openspec-assets/prompts/opsx-explore.md',
  'workflow/openspec-assets/prompts/opsx-propose.md',
];
const EXPECTED_ASSET_METADATA = [
  {
    target: 'codex',
    kind: 'skill',
    sourceRoot: 'temporary-project',
    sourcePath: '.codex/skills/openspec-explore/SKILL.md',
    destinationPath: '.codex/skills/openspec-explore/SKILL.md',
    mirrorOf: null,
  },
  {
    target: 'codex',
    kind: 'skill',
    sourceRoot: 'temporary-project',
    sourcePath: '.codex/skills/openspec-propose/SKILL.md',
    destinationPath: '.codex/skills/openspec-propose/SKILL.md',
    mirrorOf: null,
  },
  {
    target: 'claude',
    kind: 'skill',
    sourceRoot: 'temporary-project',
    sourcePath: '.claude/skills/openspec-explore/SKILL.md',
    destinationPath: '.claude/skills/openspec-explore/SKILL.md',
    mirrorOf: null,
  },
  {
    target: 'claude',
    kind: 'skill',
    sourceRoot: 'temporary-project',
    sourcePath: '.claude/skills/openspec-propose/SKILL.md',
    destinationPath: '.claude/skills/openspec-propose/SKILL.md',
    mirrorOf: null,
  },
  {
    target: 'agents',
    kind: 'skill',
    sourceRoot: 'temporary-project',
    sourcePath: '.codex/skills/openspec-explore/SKILL.md',
    destinationPath: '.agents/skills/openspec-explore/SKILL.md',
    mirrorOf: '.codex/skills/openspec-explore/SKILL.md',
  },
  {
    target: 'agents',
    kind: 'skill',
    sourceRoot: 'temporary-project',
    sourcePath: '.codex/skills/openspec-propose/SKILL.md',
    destinationPath: '.agents/skills/openspec-propose/SKILL.md',
    mirrorOf: '.codex/skills/openspec-propose/SKILL.md',
  },
  {
    target: 'codex',
    kind: 'prompt',
    sourceRoot: 'isolated-codex-home',
    sourcePath: 'prompts/opsx-explore.md',
    destinationPath: 'workflow/openspec-assets/prompts/opsx-explore.md',
    mirrorOf: null,
  },
  {
    target: 'codex',
    kind: 'prompt',
    sourceRoot: 'isolated-codex-home',
    sourcePath: 'prompts/opsx-propose.md',
    destinationPath: 'workflow/openspec-assets/prompts/opsx-propose.md',
    mirrorOf: null,
  },
];

type ManifestEntry = {
  target: string;
  kind: string;
  sourceRoot: string;
  sourcePath: string;
  destinationPath: string;
  mirrorOf: string | null;
  sourceDigest: string;
  overlayDigest: string;
  finalDigest: string;
};

type Manifest = {
  schemaVersion: number;
  generator: {
    package: string;
    version: string;
    argv: string[];
    tools: string[];
    profile: string;
    delivery: string;
    workflows: string[];
    sourceClosures: Array<{
      root: string;
      disposition: string;
      files: string[];
    }>;
  };
  overlay: { version: number; policyDigest: string };
  formatter: {
    runner: string;
    configurationDigest: string;
    assetParser: string;
    manifestParser: string;
  };
  assets: ManifestEntry[];
};

test('tool-plural generation is isolated, three-stage pinned, and byte deterministic', () => {
  const repository = temporaryRepository();
  const callerHome = fs.mkdtempSync(
    path.join(os.tmpdir(), 'openspec-assets-caller-home-'),
  );
  const captureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'openspec-assets-capture-'),
  );
  const capturePath = path.join(captureRoot, 'calls.json');
  const sentinel = path.join(callerHome, 'sentinel');
  fs.writeFileSync(sentinel, 'unchanged\n');
  fs.mkdirSync(path.join(repository, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(repository, '.claude/settings.json'),
    '{"retained":true}\n',
  );
  fs.mkdirSync(path.join(repository, '.claude/commands'), { recursive: true });
  fs.writeFileSync(
    path.join(repository, '.claude/commands/unrelated.md'),
    'Unrelated Claude command.\n',
  );
  try {
    writeControl(repository, {
      forbiddenEnvironmentRoot: callerHome,
      externalCapturePath: capturePath,
    });
    const options = {
      installationRepositoryRoot: repository,
      formatterRepositoryRoot: repository,
      callerEnvironment: {
        ...process.env,
        HOME: callerHome,
        CODEX_HOME: callerHome,
      },
    };
    const first = generateOpenSpecPlanningAssets(repository, options);

    assert.deepEqual(first.assetPaths, EXPECTED_ASSET_PATHS);
    assert.equal(first.manifestPath, OPENSPEC_ASSET_MANIFEST_PATH);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'unchanged\n');
    assert.deepEqual(fs.readdirSync(callerHome), ['sentinel']);
    assert.equal(
      fs.readFileSync(path.join(repository, '.claude/settings.json'), 'utf8'),
      '{"retained":true}\n',
    );
    assert.equal(
      fs.existsSync(path.join(repository, '.claude/commands/opsx')),
      false,
    );
    assert.equal(
      fs.readFileSync(
        path.join(repository, '.claude/commands/unrelated.md'),
        'utf8',
      ),
      'Unrelated Claude command.\n',
    );

    const manifest = readManifest(repository);
    assert.equal(manifest.schemaVersion, 2);
    assert.equal(manifest.generator.package, '@fission-ai/openspec');
    assert.equal(manifest.generator.version, '1.6.0');
    assert.deepEqual(manifest.generator.argv, [
      'init',
      '<temporary-project>',
      '--tools',
      'codex,claude',
      '--profile',
      'custom',
      '--force',
    ]);
    assert.deepEqual(manifest.generator.tools, ['codex', 'claude']);
    assert.equal(manifest.generator.profile, 'custom');
    assert.equal(manifest.generator.delivery, 'both');
    assert.deepEqual(manifest.generator.workflows, ['explore', 'propose']);
    assert.deepEqual(manifest.generator.sourceClosures, [
      {
        root: 'temporary-project',
        disposition: 'reviewed-source-and-discarded-scaffold',
        files: [
          '.claude/commands/opsx/explore.md',
          '.claude/commands/opsx/propose.md',
          '.claude/skills/openspec-explore/SKILL.md',
          '.claude/skills/openspec-propose/SKILL.md',
          '.codex/skills/openspec-explore/SKILL.md',
          '.codex/skills/openspec-propose/SKILL.md',
          'openspec/config.yaml',
        ],
      },
      {
        root: 'isolated-codex-home',
        disposition: 'reviewed-source',
        files: ['prompts/opsx-explore.md', 'prompts/opsx-propose.md'],
      },
    ]);
    assert.equal(manifest.overlay.version, 2);
    assert.match(manifest.overlay.policyDigest, /^[0-9a-f]{64}$/);
    assert.equal(
      manifest.formatter.runner,
      'node-package-bin:.:prettier/prettier',
    );
    assert.match(manifest.formatter.configurationDigest, /^[0-9a-f]{64}$/);
    assert.equal(manifest.formatter.assetParser, 'markdown');
    assert.equal(manifest.formatter.manifestParser, 'json');
    assert.equal(manifest.assets.length, EXPECTED_ASSET_PATHS.length);
    assert.deepEqual(
      manifest.assets.map(
        ({ sourceDigest, overlayDigest, finalDigest, ...metadata }) => {
          void sourceDigest;
          void overlayDigest;
          void finalDigest;
          return metadata;
        },
      ),
      EXPECTED_ASSET_METADATA,
    );
    for (const entry of manifest.assets) {
      assert.match(entry.sourceDigest, /^[0-9a-f]{64}$/);
      assert.match(entry.overlayDigest, /^[0-9a-f]{64}$/);
      assert.match(entry.finalDigest, /^[0-9a-f]{64}$/);
      assert.notEqual(entry.sourceDigest, entry.overlayDigest);
      assert.notEqual(entry.overlayDigest, entry.finalDigest);
      assert.equal(
        entry.finalDigest,
        digest(fs.readFileSync(path.join(repository, entry.destinationPath))),
      );
    }

    assertToolMirrors(repository);
    assert.equal(checkOpenSpecPlanningAssets(repository, options).valid, true);
    const firstBytes = governedBytes(repository);
    generateOpenSpecPlanningAssets(repository, options);
    assert.deepEqual(governedBytes(repository), firstBytes);
    assert.equal(readFormatterCount(repository), 14);
    const captures = JSON.parse(fs.readFileSync(capturePath, 'utf8')) as Array<{
      args: string[];
      cwd: string;
      environment: string[];
      sources: Record<string, string>;
    }>;
    assert.equal(captures.length, 3);
    for (const capture of captures) {
      assert.deepEqual(capture.args.slice(0, 1), ['init']);
      assert.equal(capture.args[3], 'codex,claude');
      assert.equal(path.basename(capture.args[1]!), 'project');
      assert.equal(path.dirname(capture.args[1]!), capture.cwd);
      assert.deepEqual(
        [...new Set(capture.environment.map((entry) => path.dirname(entry)))],
        [capture.cwd],
      );
      assert.equal(capture.environment.includes(callerHome), false);
    }
    for (const entry of manifest.assets) {
      const captureKey =
        entry.sourceRoot === 'isolated-codex-home'
          ? `codex-home/${entry.sourcePath}`
          : entry.sourcePath;
      const rawSource = captures[0]!.sources[captureKey];
      assert.notEqual(rawSource, undefined, captureKey);
      assert.equal(entry.sourceDigest, digest(rawSource!));
      assert.equal(
        entry.overlayDigest,
        digest(applyOpenSpecPlanningAssetOverlay(rawSource!)),
      );
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(callerHome, { recursive: true, force: true });
    fs.rmSync(captureRoot, { recursive: true, force: true });
  }
});

test('checking never resolves the formatter and never rewrites success or failure', () => {
  const repository = temporaryRepository();
  try {
    const options = fixtureOptions(repository);
    generateOpenSpecPlanningAssets(repository, options);
    const formatterCount = readFormatterCount(repository);
    fs.renameSync(
      path.join(repository, 'node_modules/prettier/bin/prettier.mjs'),
      path.join(repository, 'node_modules/prettier/bin/prettier.poisoned'),
    );
    const checkOptions = {
      ...options,
      formatterRepositoryRoot: path.join(repository, 'missing-formatter-root'),
    };

    const beforeSuccess = repositorySnapshot(repository);
    assert.equal(
      checkOpenSpecPlanningAssets(repository, checkOptions).valid,
      true,
    );
    assert.deepEqual(repositorySnapshot(repository), beforeSuccess);
    assert.equal(readFormatterCount(repository), formatterCount);

    const driftPath = path.join(repository, EXPECTED_ASSET_PATHS[0]!);
    fs.appendFileSync(driftPath, '\npost-generation formatting drift\n');
    const beforeFailure = repositorySnapshot(repository);
    assert.throws(
      () => checkOpenSpecPlanningAssets(repository, checkOptions),
      (error) => isWorkflowError(error, 'OPENSPEC_ASSET_REPOSITORY_DRIFT'),
    );
    assert.deepEqual(repositorySnapshot(repository), beforeFailure);
    assert.equal(readFormatterCount(repository), formatterCount);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('source, overlay, final, target, and mirror drift all fail closed', async (t) => {
  await t.test('upstream source digest drift', () => {
    const repository = temporaryRepository();
    try {
      generateOpenSpecPlanningAssets(repository, fixtureOptions(repository));
      writeControl(repository, { rawSuffix: '\nNew upstream source.\n' });
      const before = repositorySnapshot(repository);
      assert.throws(
        () =>
          checkOpenSpecPlanningAssets(repository, fixtureOptions(repository)),
        (error) => isWorkflowError(error, 'OPENSPEC_ASSET_GENERATOR_DRIFT'),
      );
      assert.deepEqual(repositorySnapshot(repository), before);
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });

  await t.test('every manifest entry enforces all three digest stages', () => {
    const repository = temporaryRepository();
    try {
      generateOpenSpecPlanningAssets(repository, fixtureOptions(repository));
      const original = readManifest(repository);
      for (const [index, entry] of original.assets.entries()) {
        for (const digestField of [
          'sourceDigest',
          'overlayDigest',
          'finalDigest',
        ] as const) {
          const mutated = structuredClone(original);
          mutated.assets[index]![digestField] = '0'.repeat(64);
          writeManifest(repository, mutated);
          const expectedCode =
            digestField === 'finalDigest'
              ? 'OPENSPEC_ASSET_REPOSITORY_DRIFT'
              : 'OPENSPEC_ASSET_GENERATOR_DRIFT';
          assert.throws(
            () =>
              checkOpenSpecPlanningAssets(
                repository,
                fixtureOptions(repository),
              ),
            (error) => isWorkflowError(error, expectedCode),
            `${entry.destinationPath} ${digestField}`,
          );
        }
      }
      writeManifest(repository, original);
      assert.equal(
        checkOpenSpecPlanningAssets(repository, fixtureOptions(repository))
          .valid,
        true,
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });

  for (const extraPath of [
    '.codex/skills/openspec-archive-change/SKILL.md',
    '.claude/skills/openspec-archive-change/SKILL.md',
    '.agents/skills/openspec-archive-change/SKILL.md',
    '.codex/skills/spectra-apply/SKILL.md',
    '.claude/skills/spectra-apply/SKILL.md',
    '.agents/skills/spectra-apply/SKILL.md',
    '.codex/skills/openspec_apply/SKILL.md',
    '.claude/skills/opsx-apply/SKILL.md',
    '.agents/skills/openspec.apply/SKILL.md',
    '.codex/skills/openspecapply/SKILL.md',
    '.claude/skills/opsxapply/SKILL.md',
    '.agents/skills/spectraapply/SKILL.md',
    '.agents/skills/spectra apply/SKILL.md',
    '.claude/commands/opsx/apply.md',
    '.claude/commands/opsx_apply.md',
    '.claude/commands/opsxapply.md',
    '.claude/commands/openspec_apply.md',
    '.claude/commands/spectra_apply.md',
    '.claude/commands/foo/openspec.md',
    'workflow/openspec-assets/prompts/opsx-archive.md',
  ]) {
    await t.test(`unexpected repository path ${extraPath}`, () => {
      const repository = temporaryRepository();
      try {
        generateOpenSpecPlanningAssets(repository, fixtureOptions(repository));
        const extra = path.join(repository, extraPath);
        fs.mkdirSync(path.dirname(extra), { recursive: true });
        fs.writeFileSync(extra, 'unexpected\n');
        assert.throws(
          () =>
            checkOpenSpecPlanningAssets(repository, fixtureOptions(repository)),
          (error) => isWorkflowError(error, 'OPENSPEC_ASSET_CLOSURE_INVALID'),
        );
      } finally {
        fs.rmSync(repository, { recursive: true, force: true });
      }
    });
  }

  await t.test(
    'neutral Claude command name cannot hide asset authority',
    () => {
      const repository = temporaryRepository();
      try {
        generateOpenSpecPlanningAssets(repository, fixtureOptions(repository));
        const commandPath = path.join(
          repository,
          '.claude/commands/reconcile.md',
        );
        fs.mkdirSync(path.dirname(commandPath), { recursive: true });
        fs.writeFileSync(commandPath, 'Run pnpm exec openspec archive demo.\n');
        assert.throws(
          () =>
            checkOpenSpecPlanningAssets(repository, fixtureOptions(repository)),
          (error) => isWorkflowError(error, 'OPENSPEC_ASSET_CLOSURE_INVALID'),
        );
      } finally {
        fs.rmSync(repository, { recursive: true, force: true });
      }
    },
  );

  for (const hiddenCommand of [
    'printf open | xargs -I@ @spec archive demo',
    'base64 -d <<< b3BlbnNwZWMgYXJjaGl2ZSBkZW1v | sh',
    'pnpm exec open**spec** archive demo',
  ]) {
    await t.test(`neutral Claude command rejects ${hiddenCommand}`, () => {
      const repository = temporaryRepository();
      try {
        generateOpenSpecPlanningAssets(repository, fixtureOptions(repository));
        const commandPath = path.join(
          repository,
          '.claude/commands/reconcile.md',
        );
        fs.mkdirSync(path.dirname(commandPath), { recursive: true });
        fs.writeFileSync(commandPath, `${hiddenCommand}\n`);
        assert.throws(
          () =>
            checkOpenSpecPlanningAssets(repository, fixtureOptions(repository)),
          (error) => isWorkflowError(error, 'OPENSPEC_ASSET_CLOSURE_INVALID'),
        );
      } finally {
        fs.rmSync(repository, { recursive: true, force: true });
      }
    });
  }

  for (const skillsRoot of [
    '.codex/skills',
    '.claude/skills',
    '.agents/skills',
  ]) {
    await t.test(
      `${skillsRoot} rejects a neutral-directory lifecycle skill`,
      () => {
        const repository = temporaryRepository();
        try {
          generateOpenSpecPlanningAssets(
            repository,
            fixtureOptions(repository),
          );
          const skillPath = path.join(
            repository,
            skillsRoot,
            'reconcile/SKILL.md',
          );
          fs.mkdirSync(path.dirname(skillPath), { recursive: true });
          fs.writeFileSync(
            skillPath,
            '---\nname: openspec-archive\n---\nRun pnpm exec openspec archive demo.\n',
          );
          assert.throws(
            () =>
              checkOpenSpecPlanningAssets(
                repository,
                fixtureOptions(repository),
              ),
            (error) => isWorkflowError(error, 'OPENSPEC_ASSET_CLOSURE_INVALID'),
          );
        } finally {
          fs.rmSync(repository, { recursive: true, force: true });
        }
      },
    );
  }

  for (const target of ['agents', 'claude'] as const) {
    for (const workflow of ['explore', 'propose'] as const) {
      await t.test(
        `${target} ${workflow} final cannot self-authorize parity drift`,
        () => {
          const repository = temporaryRepository();
          try {
            generateOpenSpecPlanningAssets(
              repository,
              fixtureOptions(repository),
            );
            const manifest = readManifest(repository);
            const entry = manifest.assets.find(
              (candidate) =>
                candidate.target === target &&
                candidate.destinationPath.includes(`openspec-${workflow}`),
            );
            assert.ok(entry);
            const targetPath = path.join(repository, entry.destinationPath);
            fs.appendFileSync(targetPath, `\n${target} drift\n`);
            entry.finalDigest = digest(fs.readFileSync(targetPath));
            writeManifest(repository, manifest);
            assert.throws(
              () =>
                checkOpenSpecPlanningAssets(
                  repository,
                  fixtureOptions(repository),
                ),
              (error) =>
                isWorkflowError(
                  error,
                  target === 'agents'
                    ? 'OPENSPEC_ASSET_MIRROR_INVALID'
                    : 'OPENSPEC_ASSET_TOOL_PARITY_INVALID',
                ),
            );
          } finally {
            fs.rmSync(repository, { recursive: true, force: true });
          }
        },
      );
    }
  }
});

test('every delivered target rejects forbidden authority after digest repinning', () => {
  const repository = temporaryRepository();
  try {
    generateOpenSpecPlanningAssets(repository, fixtureOptions(repository));
    const originalManifest = readManifest(repository);
    for (const [index, entry] of originalManifest.assets.entries()) {
      const target = path.join(repository, entry.destinationPath);
      const originalContent = fs.readFileSync(target, 'utf8');
      const forbiddenContent = `${originalContent}pnpm exec openspec archive demo\n`;
      fs.writeFileSync(target, forbiddenContent);
      const mutatedManifest = structuredClone(originalManifest);
      mutatedManifest.assets[index]!.finalDigest = digest(forbiddenContent);
      writeManifest(repository, mutatedManifest);
      assert.throws(
        () =>
          checkOpenSpecPlanningAssets(repository, fixtureOptions(repository)),
        (error) => isWorkflowError(error, 'OPENSPEC_ASSET_FORBIDDEN_AUTHORITY'),
        entry.destinationPath,
      );
      fs.writeFileSync(target, originalContent);
      writeManifest(repository, originalManifest);
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('schema-v2 manifest structure and final pins fail closed', async (t) => {
  const invalidManifestCases: Array<{
    name: string;
    mutate: (manifest: Manifest) => void;
  }> = [
    {
      name: 'schema version',
      mutate: (manifest) => {
        manifest.schemaVersion = 1;
      },
    },
    {
      name: 'generator package',
      mutate: (manifest) => {
        manifest.generator.package = 'openspec';
      },
    },
    {
      name: 'generator version',
      mutate: (manifest) => {
        manifest.generator.version = '1.6.1';
      },
    },
    {
      name: 'workflow allowlist',
      mutate: (manifest) => {
        manifest.generator.workflows = ['explore', 'propose', 'apply'];
      },
    },
    {
      name: 'overlay policy',
      mutate: (manifest) => {
        manifest.overlay.policyDigest = '0'.repeat(64);
      },
    },
    {
      name: 'unknown top-level field',
      mutate: (manifest) => {
        (manifest as unknown as Record<string, unknown>).unexpected = true;
      },
    },
    {
      name: 'tool order',
      mutate: (manifest) => {
        manifest.generator.tools = ['claude', 'codex'];
      },
    },
    {
      name: 'source closure path',
      mutate: (manifest) => {
        manifest.generator.sourceClosures[0]!.files[0] =
          '.claude/commands/opsx/apply.md';
      },
    },
    {
      name: 'missing delivery',
      mutate: (manifest) => {
        manifest.assets.pop();
      },
    },
    {
      name: 'destination traversal',
      mutate: (manifest) => {
        manifest.assets[0]!.destinationPath = '../SKILL.md';
      },
    },
    {
      name: 'mirror relationship',
      mutate: (manifest) => {
        const mirror = manifest.assets.find(
          (entry) => entry.target === 'agents',
        );
        assert.ok(mirror);
        mirror.mirrorOf = '.claude/skills/openspec-explore/SKILL.md';
      },
    },
  ];

  for (const testCase of invalidManifestCases) {
    await t.test(testCase.name, () => {
      const repository = temporaryRepository();
      try {
        generateOpenSpecPlanningAssets(repository, fixtureOptions(repository));
        const manifest = readManifest(repository);
        testCase.mutate(manifest);
        writeManifest(repository, manifest);
        assert.throws(
          () =>
            checkOpenSpecPlanningAssets(repository, fixtureOptions(repository)),
          (error) => isWorkflowError(error, 'OPENSPEC_ASSET_MANIFEST_INVALID'),
        );
      } finally {
        fs.rmSync(repository, { recursive: true, force: true });
      }
    });
  }

  for (const state of ['missing', 'renamed', 'invalid JSON'] as const) {
    await t.test(`manifest ${state}`, () => {
      const repository = temporaryRepository();
      try {
        generateOpenSpecPlanningAssets(repository, fixtureOptions(repository));
        const manifestPath = path.join(
          repository,
          OPENSPEC_ASSET_MANIFEST_PATH,
        );
        if (state === 'missing') {
          fs.unlinkSync(manifestPath);
        } else if (state === 'renamed') {
          fs.renameSync(manifestPath, `${manifestPath}.renamed`);
        } else {
          fs.writeFileSync(manifestPath, '{invalid JSON\n');
        }
        const before = repositorySnapshot(repository);
        assert.throws(
          () =>
            checkOpenSpecPlanningAssets(repository, fixtureOptions(repository)),
          (error) => isWorkflowError(error, 'OPENSPEC_ASSET_MANIFEST_INVALID'),
        );
        assert.deepEqual(repositorySnapshot(repository), before);
      } finally {
        fs.rmSync(repository, { recursive: true, force: true });
      }
    });
  }

  for (const testCase of [
    {
      name: 'duplicate top-level key',
      mutate: (content: string) => content.replace('{', '{"schemaVersion": 1,'),
    },
    {
      name: 'duplicate nested key',
      mutate: (content: string) =>
        content.replace('"generator": {', '"generator": {"version": "0.0.0",'),
    },
    {
      name: 'duplicate asset key',
      mutate: (content: string) =>
        content.replace(
          '"target": "codex",',
          '"target": "claude", "target": "codex",',
        ),
    },
  ]) {
    await t.test(testCase.name, () => {
      const repository = temporaryRepository();
      try {
        generateOpenSpecPlanningAssets(repository, fixtureOptions(repository));
        const manifestPath = path.join(
          repository,
          OPENSPEC_ASSET_MANIFEST_PATH,
        );
        fs.writeFileSync(
          manifestPath,
          testCase.mutate(fs.readFileSync(manifestPath, 'utf8')),
        );
        assert.throws(
          () =>
            checkOpenSpecPlanningAssets(repository, fixtureOptions(repository)),
          (error) => isWorkflowError(error, 'OPENSPEC_ASSET_MANIFEST_INVALID'),
        );
      } finally {
        fs.rmSync(repository, { recursive: true, force: true });
      }
    });
  }

  await t.test('final digest cannot change without final bytes', () => {
    const repository = temporaryRepository();
    try {
      generateOpenSpecPlanningAssets(repository, fixtureOptions(repository));
      const manifest = readManifest(repository);
      manifest.assets[0]!.finalDigest = '0'.repeat(64);
      writeManifest(repository, manifest);
      assert.throws(
        () =>
          checkOpenSpecPlanningAssets(repository, fixtureOptions(repository)),
        (error) => isWorkflowError(error, 'OPENSPEC_ASSET_REPOSITORY_DRIFT'),
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });
});

test('final-byte verification rejects malformed UTF-8 without lossy decoding', () => {
  const repository = temporaryRepository();
  try {
    generateOpenSpecPlanningAssets(repository, fixtureOptions(repository));
    const manifest = readManifest(repository);
    const prompt = manifest.assets.find((entry) => entry.kind === 'prompt');
    assert.ok(prompt);
    const target = path.join(repository, prompt.destinationPath);
    const original = fs.readFileSync(target);
    prompt.finalDigest = digest(
      Buffer.concat([original, Buffer.from('\uFFFD', 'utf8')]),
    );
    writeManifest(repository, manifest);
    fs.appendFileSync(target, Buffer.from([0xff]));

    assert.throws(
      () => checkOpenSpecPlanningAssets(repository, fixtureOptions(repository)),
      (error) => isWorkflowError(error, 'OPENSPEC_ASSET_CONTENT_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('final-byte verification treats a UTF-8 BOM as governed bytes', () => {
  const repository = temporaryRepository();
  try {
    generateOpenSpecPlanningAssets(repository, fixtureOptions(repository));
    const target = path.join(repository, EXPECTED_ASSET_PATHS.at(-1)!);
    fs.writeFileSync(
      target,
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), fs.readFileSync(target)]),
    );
    assert.throws(
      () => checkOpenSpecPlanningAssets(repository, fixtureOptions(repository)),
      (error) => isWorkflowError(error, 'OPENSPEC_ASSET_REPOSITORY_DRIFT'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('governed final paths reject symbolic and additional hard links', async (t) => {
  for (const kind of ['symbolic link', 'hard link'] as const) {
    await t.test(kind, () => {
      const repository = temporaryRepository();
      try {
        generateOpenSpecPlanningAssets(repository, fixtureOptions(repository));
        const governed = path.join(repository, EXPECTED_ASSET_PATHS[0]!);
        const original = `${governed}.original`;
        fs.renameSync(governed, original);
        if (kind === 'symbolic link') {
          fs.symlinkSync(original, governed);
        } else {
          fs.linkSync(original, governed);
        }
        assert.throws(
          () =>
            checkOpenSpecPlanningAssets(repository, fixtureOptions(repository)),
          (error) => isWorkflowError(error, 'OPENSPEC_ASSET_PATH_UNSAFE'),
        );
      } finally {
        fs.rmSync(repository, { recursive: true, force: true });
      }
    });
  }
});

test('optional delivery roots reject symbolic-link aliases', () => {
  const repository = temporaryRepository();
  const external = fs.mkdtempSync(
    path.join(os.tmpdir(), 'openspec-assets-external-commands-'),
  );
  try {
    generateOpenSpecPlanningAssets(repository, fixtureOptions(repository));
    fs.mkdirSync(path.join(repository, '.claude'), { recursive: true });
    fs.symlinkSync(external, path.join(repository, '.claude/commands'));
    assert.throws(
      () => checkOpenSpecPlanningAssets(repository, fixtureOptions(repository)),
      (error) => isWorkflowError(error, 'OPENSPEC_ASSET_PATH_UNSAFE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(external, { recursive: true, force: true });
  }
});

test('generation preflights the complete write plan before formatter or delivery writes', async (t) => {
  for (const testCase of [
    {
      name: 'unexpected planning namespace',
      prepare: (repository: string) => {
        const extra = path.join(
          repository,
          '.agents/skills/spectraapply/SKILL.md',
        );
        fs.mkdirSync(path.dirname(extra), { recursive: true });
        fs.writeFileSync(extra, 'unexpected\n');
      },
      errorCode: 'OPENSPEC_ASSET_CLOSURE_INVALID',
    },
    {
      name: 'unsafe later delivery target',
      prepare: (repository: string) => {
        const target = path.join(
          repository,
          '.agents/skills/openspec-propose/SKILL.md',
        );
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.symlinkSync(path.join(repository, 'package.json'), target);
      },
      errorCode: 'OPENSPEC_ASSET_PATH_UNSAFE',
    },
    {
      name: 'unwritable later delivery parent',
      prepare: (repository: string) => {
        const parent = path.join(repository, '.agents/skills');
        fs.mkdirSync(parent, { recursive: true });
        fs.chmodSync(parent, 0o555);
      },
      errorCode: 'OPENSPEC_ASSET_PATH_UNSAFE',
    },
    {
      name: 'unwritable later delivery target',
      prepare: (repository: string) => {
        const target = path.join(
          repository,
          '.agents/skills/openspec-propose/SKILL.md',
        );
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, 'protected\n');
        fs.chmodSync(target, 0o444);
      },
      errorCode: 'OPENSPEC_ASSET_PATH_UNSAFE',
    },
  ]) {
    await t.test(testCase.name, () => {
      const repository = temporaryRepository();
      try {
        testCase.prepare(repository);
        const before = repositorySnapshot(repository);
        assert.throws(
          () =>
            generateOpenSpecPlanningAssets(
              repository,
              fixtureOptions(repository),
            ),
          (error) => isWorkflowError(error, testCase.errorCode),
        );
        assert.deepEqual(repositorySnapshot(repository), before);
      } finally {
        const agentsSkills = path.join(repository, '.agents/skills');
        if (fs.lstatSync(agentsSkills, { throwIfNoEntry: false })) {
          fs.chmodSync(agentsSkills, 0o755);
        }
        const agentsPropose = path.join(
          agentsSkills,
          'openspec-propose/SKILL.md',
        );
        if (fs.lstatSync(agentsPropose, { throwIfNoEntry: false })?.isFile()) {
          fs.chmodSync(agentsPropose, 0o644);
        }
        fs.rmSync(repository, { recursive: true, force: true });
      }
    });
  }
});

test('upstream and discarded-command closures fail before repository writes', async (t) => {
  const cases = [
    {
      name: 'missing Codex skill',
      control: { omitPath: '.codex/skills/openspec-explore/SKILL.md' },
    },
    {
      name: 'missing Claude command',
      control: { omitPath: '.claude/commands/opsx/explore.md' },
    },
    {
      name: 'missing prompt',
      control: { omitPath: 'codex-home/prompts/opsx-explore.md' },
    },
    {
      name: 'extra Claude command',
      control: { extraPath: '.claude/commands/opsx/apply.md' },
    },
    { name: 'extra project output', control: { extraPath: 'unexpected.txt' } },
  ];
  for (const testCase of cases) {
    await t.test(testCase.name, () => {
      const repository = temporaryRepository();
      try {
        writeControl(repository, testCase.control);
        const before = repositorySnapshot(repository);
        assert.throws(
          () =>
            generateOpenSpecPlanningAssets(
              repository,
              fixtureOptions(repository),
            ),
          (error) => isWorkflowError(error, 'OPENSPEC_ASSET_CLOSURE_INVALID'),
        );
        assert.equal(
          fs.existsSync(path.join(repository, OPENSPEC_ASSET_MANIFEST_PATH)),
          false,
        );
        assert.deepEqual(repositorySnapshot(repository), before);
      } finally {
        fs.rmSync(repository, { recursive: true, force: true });
      }
    });
  }

  for (const workflow of ['explore', 'propose'] as const) {
    await t.test(`Codex and Claude ${workflow} raw skills diverge`, () => {
      const repository = temporaryRepository();
      try {
        writeControl(repository, { divergeClaudeWorkflow: workflow });
        const before = repositorySnapshot(repository);
        assert.throws(
          () =>
            generateOpenSpecPlanningAssets(
              repository,
              fixtureOptions(repository),
            ),
          (error) =>
            isWorkflowError(error, 'OPENSPEC_ASSET_TOOL_PARITY_INVALID'),
        );
        assert.equal(
          fs.existsSync(path.join(repository, OPENSPEC_ASSET_MANIFEST_PATH)),
          false,
        );
        assert.deepEqual(repositorySnapshot(repository), before);
      } finally {
        fs.rmSync(repository, { recursive: true, force: true });
      }
    });
  }
});

test('unexpected generator diagnostics fail before repository writes', async (t) => {
  for (const testCase of [
    {
      name: 'stdout',
      control: { diagnosticStdoutSuffix: 'unexpected\n' },
    },
    {
      name: 'stderr',
      control: { diagnosticStderrSuffix: 'unexpected\n' },
    },
    {
      name: 'stdout BOM',
      control: { diagnosticStdoutPrefix: '\uFEFF' },
    },
    {
      name: 'stderr BOM',
      control: { diagnosticStderrPrefix: '\uFEFF' },
    },
  ]) {
    await t.test(testCase.name, () => {
      const repository = temporaryRepository();
      try {
        writeControl(repository, testCase.control);
        const before = repositorySnapshot(repository);
        assert.throws(
          () =>
            generateOpenSpecPlanningAssets(
              repository,
              fixtureOptions(repository),
            ),
          (error) => isWorkflowError(error, 'OPENSPEC_ASSET_GENERATION_FAILED'),
        );
        assert.equal(
          fs.existsSync(path.join(repository, OPENSPEC_ASSET_MANIFEST_PATH)),
          false,
        );
        assert.deepEqual(repositorySnapshot(repository), before);
      } finally {
        fs.rmSync(repository, { recursive: true, force: true });
      }
    });
  }
});

test('generation rejects a formatter that changes manifest semantics', () => {
  const repository = temporaryRepository();
  try {
    writeControl(repository, { corruptManifest: true });
    assert.throws(
      () =>
        generateOpenSpecPlanningAssets(repository, fixtureOptions(repository)),
      (error) => isWorkflowError(error, 'OPENSPEC_ASSET_FORMAT_FAILED'),
    );
    for (const filePath of [
      ...EXPECTED_ASSET_PATHS,
      OPENSPEC_ASSET_MANIFEST_PATH,
    ]) {
      assert.equal(fs.existsSync(path.join(repository, filePath)), false);
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('generation rejects formatter-created duplicate manifest keys before delivery', () => {
  const repository = temporaryRepository();
  try {
    writeControl(repository, { duplicateManifestKey: true });
    assert.throws(
      () =>
        generateOpenSpecPlanningAssets(repository, fixtureOptions(repository)),
      (error) => isWorkflowError(error, 'OPENSPEC_ASSET_FORMAT_FAILED'),
    );
    for (const filePath of [
      ...EXPECTED_ASSET_PATHS,
      OPENSPEC_ASSET_MANIFEST_PATH,
    ]) {
      assert.equal(fs.existsSync(path.join(repository, filePath)), false);
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('invalid formatter UTF-8 is a formatter failure before delivery writes', () => {
  const repository = temporaryRepository();
  try {
    writeControl(repository, { invalidFormatterUtf8: true });
    assert.throws(
      () =>
        generateOpenSpecPlanningAssets(repository, fixtureOptions(repository)),
      (error) => isWorkflowError(error, 'OPENSPEC_ASSET_FORMAT_FAILED'),
    );
    for (const filePath of [
      ...EXPECTED_ASSET_PATHS,
      OPENSPEC_ASSET_MANIFEST_PATH,
    ]) {
      assert.equal(fs.existsSync(path.join(repository, filePath)), false);
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('formatter metadata binds the resolved runner closure', () => {
  const repository = temporaryRepository();
  try {
    generateOpenSpecPlanningAssets(repository, fixtureOptions(repository));
    const initialDigest =
      readManifest(repository).formatter.configurationDigest;
    fs.appendFileSync(
      path.join(repository, 'node_modules/prettier/bin/prettier.mjs'),
      '\n// Reviewed fixture runner drift.\n',
    );
    generateOpenSpecPlanningAssets(repository, fixtureOptions(repository));
    const runnerDriftDigest =
      readManifest(repository).formatter.configurationDigest;
    assert.notEqual(runnerDriftDigest, initialDigest);
    fs.writeFileSync(
      path.join(repository, 'prettier.config.cjs'),
      'module.exports = { semi: true };\n',
    );
    generateOpenSpecPlanningAssets(repository, fixtureOptions(repository));
    const configDriftDigest =
      readManifest(repository).formatter.configurationDigest;
    assert.notEqual(configDriftDigest, runnerDriftDigest);
    fs.writeFileSync(
      path.join(repository, 'package.yaml'),
      'prettier:\n  proseWrap: always\n  printWidth: 40\n',
    );
    generateOpenSpecPlanningAssets(repository, fixtureOptions(repository));
    assert.notEqual(
      readManifest(repository).formatter.configurationDigest,
      configDriftDigest,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('real pinned OpenSpec and Prettier generate the plural closure read-only', () => {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-real-openspec-assets-'),
  );
  const options = {
    installationRepositoryRoot: sourceRepositoryRoot,
    formatterRepositoryRoot: sourceRepositoryRoot,
  };
  try {
    const generated = generateOpenSpecPlanningAssets(repository, options);
    assert.deepEqual(generated.assetPaths, EXPECTED_ASSET_PATHS);
    assertToolMirrors(repository);
    const before = repositorySnapshot(repository);
    assert.equal(checkOpenSpecPlanningAssets(repository, options).valid, true);
    assert.deepEqual(repositorySnapshot(repository), before);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('forbidden lifecycle and Spectra authority is prefix-independent', () => {
  const safe = [
    'pnpm exec openspec list',
    'pnpm exec openspec status',
    'pnpm workflow plan-commit demo-change',
    'pnpm workflow start demo-change --task 1.1',
    'The historical name Spectra appears only as prose.',
    'The historical name spectra also appears only as prose.',
    '<artifact>Planning prose.</artifact>',
    '',
  ].join('\n');
  verifyOpenSpecPlanningAssetContent(safe);

  const forbidden = [
    'openspec list',
    'openspec "list"',
    'npx openspec status',
    'pnpm openspec validate demo',
    'pnpm exec openspec --no-color list',
    'pnpm exec openspec config set foo bar',
    'pnpm exec openspec --version',
    'pnpm exec openspec help',
    'pnpm exec openspec frobnicate',
    'npx openspec frobnicate',
    'npx pnpm exec openspec list',
    'env PATH=/tmp pnpm exec openspec list',
    'PATH=/tmp pnpm exec openspec list',
    'OPENSPEC_STORE=external pnpm exec openspec list',
    'corepack pnpm exec openspec list',
    'sh -c "pnpm exec openspec list"',
    'sudo pnpm exec openspec new change demo',
    'doas pnpm exec openspec status',
    'OpenSpec list',
    'pnpm exec OpenSpec frobnicate',
    'OPENSPEC --version',
    'openspec apply demo',
    'pnpm exec openspec --no-color archive demo',
    'pnpm exec openspec "archive" demo',
    'pnpm exec openspec ar"chive" demo',
    'pnpm exec openspec arch\\ive demo',
    'pnpm exec open\\spec archive demo',
    'pnpm exec op\\enspec archive demo',
    'o=open\n${o}spec archive demo',
    'name=archive\npnpm exec open${EMPTY}spec $name',
    'pnpm exec openspec \\\narchive demo',
    'node node_modules/@fission-ai/openspec/bin/openspec.js archive demo',
    'printf archive | xargs openspec',
    '`printf open`spec archive demo',
    '`printf spec`tra archive demo',
    '`sed s/x//<<<xopen`spec archive demo',
    '`sed s/x//<<<xspect`ra archive demo',
    '>     node_modules/.bin/`dd if=pnpm-lock.yaml bs=1 skip=600 count=8 2>/dev/null` archive demo',
    'printf open | xargs -I@ @spec archive',
    'base64 -d<<<cG5wbSBleGVjIG9wZW5zcGVjIGFyY2hpdmUgZGVtbwo=|sh',
    'base64 -d <<< b3BlbnNwZWMgYXJjaGl2ZSBkZW1v | sh',
    '`node -p \'Buffer.from("6f70656e73706563","hex").toString()\'` archive demo',
    'bash <(node -p \'Buffer.from("706e706d2065786563206f70656e7370656320617263686976652064656d6f0a","hex").toString()\')',
    'node -e \'require("child_process").execFileSync("pnpm",["exec",Buffer.from("6f70656e73706563","hex").toString(),Buffer.from("61726368697665","hex").toString(),"demo"])\'',
    './node_modules/.bin/open?pec archive demo',
    './node_modules/.bin/open[s]pec archive demo',
    './node_modules/.bin/open[a-z]pec archive demo',
    './bin/spec[a-z]ra archive demo',
    './bin/open[[:lower:]]pec archive demo',
    './bin/spec[[:lower:]]ra archive demo',
    './bin/open[[=s=]]pec archive demo',
    './bin/spec[[.t.]]ra archive demo',
    'shopt -s extglob\n./bin/open@(s)pec archive demo',
    'setopt extendedglob\n./bin/open(s)pec archive demo',
    'setopt extendedglob\n./bin/open(spec) archive demo',
    'setopt extendedglob\n./bin/open(s)#pec archive demo',
    'setopt extendedglob\n./bin/open(s)##pec archive demo',
    'setopt extendedglob\n./bin/(#a1)openspxc archive demo',
    'setopt extendedglob\n./bin/^foo archive demo',
    'setopt extendedglob\n./bin/*~foo archive demo',
    'node_modules/.bin/open?pec(N) archive demo',
    'node_modules/.bin/open*pec(N) archive demo',
    'node_modules/.bin/open[s]pec(N) archive demo',
    'pnpm exec openspec update demo',
    'npx openspec sync demo',
    'pnpm exec openspec archive demo',
    'openspec bulk-archive --all',
    'pnpm exec openspec store list',
    'pnpm exec openspec list --store external',
    'pnpm exec openspec list --store=external',
    'spectra apply demo',
    'Spectra archive demo',
    'spectra propose demo',
    '- spectra frobnicate',
    '1. spectra frobnicate',
    '> spectra frobnicate',
    'Run this tool: spectra frobnicate',
    'pnpm exec spectra archive demo',
    'pnpm exec spectra --help',
    'env spectra',
    'command spectra',
    'exec spectra',
    'npm exec spectra',
    'bunx spectra',
    'yarn spectra',
    'sudo spectra',
    'doas spectra',
    'spec"tra" archive demo',
    'spec\\tra archive demo',
    'pnpm exec open**spec** archive demo',
    'pnpm exec open<!-- -->spec archive demo',
    'pnpm exec open&#x73;pec archive demo',
    'pnpm exec open<name>spec archive demo',
    'open<span\nclass="x">spec</span> archive demo',
    'open<span title=">">spec</span> archive demo',
    'open<?hidden?>spec archive demo',
    'open<!X>spec archive demo',
    'open<![CDATA[hidden]]>spec archive demo',
    'spec**tra** archive demo',
    '/spectra',
    '/spectra:apply',
    '/spectra:propose',
    '/spectra_apply',
    '/archive demo',
    '/apply demo',
    '/foo:bar',
    '(/archive demo)',
    'Command:/archive demo',
    '>/archive demo',
    'spectra-apply demo',
    'spectra-explore demo',
    'allowed-tools: Bash',
    'allowed-tools: [Bash]',
    'allowed-tools: Bash(pnpm exec openspec:*)',
    '  allowed-tools: Bash',
    '{allowed-tools: Bash}',
    '"allowed-tools": Bash',
    '"allowed\\u002dtools": Bash',
    'Bash(openspec:*)',
    '/openspec:archive',
    '/openspec_apply',
    '/op**en**spec:archive',
    '/opsx:apply',
    '/opsx_apply',
    '/op<!-- -->sx:apply',
    'open[spec][cmd] archive demo\n\n[cmd]: https://example.invalid',
    'open[spec][] archive demo\n\n[spec]: https://example.invalid',
    'open[spec] archive demo\n\n[spec]: https://example.invalid',
    'open[spec][cmd] archive demo\n\n[cmd]:\n  https://example.invalid',
    'open[spec][cmd] archive demo\n\n[cmd]:\n  <https://example.invalid>',
    'open[spec][c\nmd] archive demo\n\n[c md]: https://example.invalid',
    'open[spec](\nhttps://example.invalid) archive demo',
    'open[spec](https://example.invalid\n"title") archive demo',
    'open[spec][cmd] archive demo\n\n> [cmd]: https://example.invalid',
    '> open[spec][cmd] archive demo\n>\n> [cmd]: https://example.invalid',
    'open[spec][cmd] archive demo\n\n- [cmd]: https://example.invalid',
    'open[spec][c md] archive demo\n\n> [c\n> md]: https://example.invalid',
    '> open[spec][c\n> md] archive demo\n>\n> [c md]: https://example.invalid',
    '<!-- pnpm exec open"spec ar"chive demo -->',
    '<!-- spec"tra" archive demo -->',
    '<!-- /op"sx:ap"ply -->',
    'AskUserQuestion tool',
    'AskUserQuestion({})',
    'allowed-tools: AskUserQuestion',
    'TodoWrite tool',
    'TodoWrite([])',
    'allowed-tools: TodoWrite',
  ];
  for (const command of forbidden) {
    assert.throws(
      () => verifyOpenSpecPlanningAssetContent(`${safe}${command}\n`),
      (error) => isWorkflowError(error, 'OPENSPEC_ASSET_FORBIDDEN_AUTHORITY'),
      command,
    );
  }
});

function temporaryRepository(): string {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-openspec-assets-'),
  );
  fs.writeFileSync(
    path.join(repository, 'package.json'),
    `${JSON.stringify({
      name: 'openspec-asset-fixture',
      private: true,
      devDependencies: {},
    })}\n`,
  );
  installFakeOpenSpec(repository);

  const manifestPath = path.join(repository, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.devDependencies.prettier = '3.0.0';
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const openspecBin = path.join(
    repository,
    'node_modules/@fission-ai/openspec/bin/openspec.js',
  );
  fs.copyFileSync(path.join(FIXTURE_ROOT, 'fake-openspec.mjs'), openspecBin);

  const prettierRoot = path.join(repository, 'node_modules/prettier');
  fs.mkdirSync(path.join(prettierRoot, 'bin'), { recursive: true });
  fs.writeFileSync(
    path.join(prettierRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: 'prettier',
        version: '3.0.0',
        type: 'module',
        bin: { prettier: './bin/prettier.mjs' },
      },
      null,
      2,
    )}\n`,
  );
  fs.copyFileSync(
    path.join(FIXTURE_ROOT, 'fake-prettier.mjs'),
    path.join(prettierRoot, 'bin/prettier.mjs'),
  );
  writeControl(repository, {});
  return repository;
}

function fixtureOptions(repository: string) {
  return {
    installationRepositoryRoot: repository,
    formatterRepositoryRoot: repository,
  };
}

function writeControl(repository: string, value: object): void {
  fs.writeFileSync(
    path.join(repository, 'openspec-asset-fixture-control.json'),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

function readFormatterCount(repository: string): number {
  return Number.parseInt(
    fs.readFileSync(
      path.join(repository, 'openspec-asset-fixture-formatter-count'),
      'utf8',
    ),
    10,
  );
}

function readManifest(repository: string): Manifest {
  return JSON.parse(
    fs.readFileSync(
      path.join(repository, OPENSPEC_ASSET_MANIFEST_PATH),
      'utf8',
    ),
  );
}

function writeManifest(repository: string, manifest: Manifest): void {
  fs.writeFileSync(
    path.join(repository, OPENSPEC_ASSET_MANIFEST_PATH),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

function governedBytes(repository: string): Record<string, string> {
  return Object.fromEntries(
    [...EXPECTED_ASSET_PATHS, OPENSPEC_ASSET_MANIFEST_PATH].map((filePath) => [
      filePath,
      fs.readFileSync(path.join(repository, filePath), 'utf8'),
    ]),
  );
}

function repositorySnapshot(repository: string): Record<
  string,
  {
    kind: 'directory' | 'file' | 'symbolic-link';
    mode: number;
    inode: number;
    modified: number;
    content?: string;
  }
> {
  const entries: ReturnType<typeof repositorySnapshot> = {};
  const visit = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = path.relative(repository, absolute);
      const stats = fs.lstatSync(absolute);
      const common = {
        mode: stats.mode,
        inode: stats.ino,
        modified: stats.mtimeMs,
      };
      if (stats.isSymbolicLink()) {
        entries[relative] = {
          kind: 'symbolic-link',
          ...common,
          content: fs.readlinkSync(absolute),
        };
      } else if (stats.isDirectory()) {
        entries[relative] = { kind: 'directory', ...common };
        visit(absolute);
      } else {
        assert.equal(stats.isFile(), true);
        entries[relative] = {
          kind: 'file',
          ...common,
          content: digest(fs.readFileSync(absolute)),
        };
      }
    }
  };
  visit(repository);
  return entries;
}

function assertToolMirrors(repository: string): void {
  for (const skillName of ['openspec-explore', 'openspec-propose']) {
    const codex = fs.readFileSync(
      path.join(repository, `.codex/skills/${skillName}/SKILL.md`),
    );
    const claude = fs.readFileSync(
      path.join(repository, `.claude/skills/${skillName}/SKILL.md`),
    );
    const agents = fs.readFileSync(
      path.join(repository, `.agents/skills/${skillName}/SKILL.md`),
    );
    assert.deepEqual(claude, codex);
    assert.deepEqual(agents, codex);
  }
}

function digest(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}
