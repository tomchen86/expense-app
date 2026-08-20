import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  projectAuthorityRemap,
  projectAuthorityRemapChecks,
  projectAuthorityRemapGuards,
  projectAuthorityRemapMaintainerPolicy,
  projectAuthorityRemapProfiles,
  projectAuthorityRemapPathRoles,
  verifyMechanicalMovePhase,
} from '../src/composition-root/authority-remap.ts';
import { materializeAuthorityRemap } from '../bootstrap/authority-remap-materializer.ts';
import {
  generateBuiltInEngineClosure,
  renderBuiltInEngineClosure,
} from '../bootstrap/generate-built-in-engine-closure.ts';
import {
  generateHarnessBootstrapRuntime,
  renderHarnessBootstrapRuntime,
} from '../bootstrap/generate-harness-bootstrap-runtime.ts';
import { generateProtectedCapabilitiesManifest } from '../bootstrap/generate-protected-capabilities.ts';
import { parseMaintainerPolicy } from '../src/modules/authority/maintainer-policy.ts';
import {
  classifyFileRole,
  parseCapabilityProfile,
} from '../src/modules/authority/maintainer-manifest.ts';
import {
  parsePathRoleRegistry,
  resolvePathRole,
} from '../src/modules/source/path-role-registry.ts';
import {
  createFixtureRepository,
  git,
  isWorkflowError,
  sourceRepositoryRoot,
} from './fixture.ts';

test('mechanical move proof binds one exact adjacent commit range and ignores later worktree state', () => {
  const repository = createFixtureRepository();
  try {
    write(repository, 'src/legacy.ts', 'export const value = 1;\n');
    commitAll(repository, 'Add legacy source');
    const baseCommit = head(repository);
    const objectId = git(repository, [
      'rev-parse',
      `${baseCommit}:src/legacy.ts`,
    ]).trim();

    move(repository, 'src/legacy.ts', 'packages/core/src/legacy.ts');
    commitAll(repository, 'Move legacy source');
    const moveCommit = head(repository);
    const request = {
      repositoryRoot: repository,
      baseCommit,
      moveCommit,
      renamePairs: [
        { from: 'src/legacy.ts', to: 'packages/core/src/legacy.ts' },
      ],
    } as const;

    const proof = verifyMechanicalMovePhase(request);
    assert.deepEqual(proof.moves, [
      {
        from: 'src/legacy.ts',
        to: 'packages/core/src/legacy.ts',
        objectId,
        mode: '100644',
      },
    ]);
    assert.equal(
      proof.baseTree,
      git(repository, ['rev-parse', `${baseCommit}^{tree}`]).trim(),
    );
    assert.equal(
      proof.moveTree,
      git(repository, ['rev-parse', `${moveCommit}^{tree}`]).trim(),
    );
    assert.match(proof.proofDigest, /^sha256:[0-9a-f]{64}$/);

    write(repository, 'worktree-only.ts', 'ignored\n');
    assert.deepEqual(verifyMechanicalMovePhase(request), proof);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('mechanical move proof reads the raw commit parent instead of caller grafts', () => {
  const repository = createFixtureRepository();
  try {
    const from = 'src/grafted-parent.ts';
    const to = 'packages/core/src/grafted-parent.ts';
    const intermediate = 'src/intermediate-only.ts';
    write(repository, from, 'export const graftedParent = true;\n');
    commitAll(repository, 'Add source before grafted move');
    const baseCommit = head(repository);

    write(repository, intermediate, 'temporary history only\n');
    commitAll(repository, 'Add intermediate history state');
    const actualParent = head(repository);
    move(repository, from, to);
    fs.rmSync(path.join(repository, intermediate));
    commitAll(repository, 'Move source after intermediate history');
    const moveCommit = head(repository);
    assert.equal(
      git(repository, ['rev-parse', `${moveCommit}^`]).trim(),
      actualParent,
    );
    fs.writeFileSync(
      path.join(repository, '.git/info/grafts'),
      `${moveCommit} ${baseCommit}\n`,
    );

    assert.throws(
      () =>
        verifyMechanicalMovePhase({
          repositoryRoot: repository,
          baseCommit,
          moveCommit,
          renamePairs: [{ from, to }],
        }),
      (error) =>
        error instanceof Error &&
        isWorkflowError(error, 'AUTHORITY_REMAP_INVALID') &&
        error.message.includes('exactly the base commit as its parent'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('reviewed content boundary reads the raw commit parent instead of caller grafts', () => {
  const repository = createFixtureRepository();
  try {
    removeFixtureActiveGuard(repository);
    const from = 'src/grafted-content.ts';
    const to = 'packages/core/src/grafted-content.ts';
    writeMaintainerPolicy(repository, (policy) => {
      policy.bootstrapEligiblePaths = ['packages/**', 'src/**'];
      policy.sealedImmutablePaths = [];
    });
    writeMaintainerProfiles(repository, {
      implementationPaths: ['packages/**', 'src/**'],
    });
    write(repository, from, 'export const graftedContent = 1;\n');
    commitAll(repository, 'Add source before grafted content');
    const baseCommit = head(repository);
    move(repository, from, to);
    commitAll(repository, 'Move source before grafted content');
    const moveCommit = head(repository);

    write(repository, to, 'export const graftedContent = 2;\n');
    commitAll(repository, 'Add intermediate content history');
    const actualParent = head(repository);
    write(repository, to, 'export const graftedContent = 3;\n');
    commitAll(repository, 'Add final reviewed content');
    const contentCommit = head(repository);
    assert.equal(
      git(repository, ['rev-parse', `${contentCommit}^`]).trim(),
      actualParent,
    );
    fs.writeFileSync(
      path.join(repository, '.git/info/grafts'),
      `${contentCommit} ${moveCommit}\n`,
    );

    assert.throws(
      () =>
        projectAuthorityRemap({
          repositoryRoot: repository,
          baseCommit,
          moveCommit,
          materializationCommit: contentCommit,
          renamePairs: [{ from, to }],
          authorityPlan: {
            changeId: 'reject-grafted-content-parent',
            taskId: '1.1',
            profileId: 'remap-profile',
            reason: 'Reject caller-local grafts in reviewed content ancestry.',
            message: 'Reject grafted content parent',
          },
        }),
      (error) =>
        error instanceof Error &&
        isWorkflowError(error, 'AUTHORITY_REMAP_INVALID') &&
        error.message.includes('single direct reviewed-content child'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('declared pairs own duplicate-blob mapping instead of Git rename similarity', () => {
  const repository = createFixtureRepository();
  try {
    write(repository, 'src/a.ts', 'same bytes\n');
    write(repository, 'src/b.ts', 'same bytes\n');
    commitAll(repository, 'Add duplicate blobs');
    const baseCommit = head(repository);

    move(repository, 'src/a.ts', 'packages/core/src/x.ts');
    move(repository, 'src/b.ts', 'packages/core/src/y.ts');
    commitAll(repository, 'Move duplicate blobs');
    const moveCommit = head(repository);

    const proof = verifyMechanicalMovePhase({
      repositoryRoot: repository,
      baseCommit,
      moveCommit,
      renamePairs: [
        { from: 'src/a.ts', to: 'packages/core/src/y.ts' },
        { from: 'src/b.ts', to: 'packages/core/src/x.ts' },
      ],
    });
    assert.deepEqual(
      proof.moves.map(({ from, to }) => ({ from, to })),
      [
        { from: 'src/a.ts', to: 'packages/core/src/y.ts' },
        { from: 'src/b.ts', to: 'packages/core/src/x.ts' },
      ],
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('path-role projection makes a risky exact role follow the moved blob', () => {
  const repository = createFixtureRepository();
  try {
    write(repository, 'src/legacy.ts', 'export const value = 1;\n');
    updatePathRoles(repository, (roles) => {
      roles.grant = ['src/legacy.ts'];
    });
    commitAll(repository, 'Add role-classified legacy source');
    const baseCommit = head(repository);

    move(repository, 'src/legacy.ts', 'packages/core/src/legacy.ts');
    commitAll(repository, 'Move role-classified source');
    const moveCommit = head(repository);
    const projected = projectAuthorityRemapPathRoles({
      repositoryRoot: repository,
      baseCommit,
      moveCommit,
      renamePairs: [
        { from: 'src/legacy.ts', to: 'packages/core/src/legacy.ts' },
      ],
    });

    assert.deepEqual(projected.roles, [
      {
        from: 'src/legacy.ts',
        to: 'packages/core/src/legacy.ts',
        role: 'grant',
        beforePattern: 'src/legacy.ts',
        afterPattern: 'packages/core/src/legacy.ts',
      },
    ]);
    assert.equal(projected.mutation?.path, 'workflow/path-roles.json');
    assert.match(
      projected.mutation?.expectedBeforeSha256 ?? '',
      /^[0-9a-f]{64}$/,
    );
    assert.match(projected.mutation?.content ?? '', /packages\/core\/src/);
    const registry = parsePathRoleRegistry(
      JSON.parse(projected.mutation!.content!),
    );
    assert.deepEqual(resolvePathRole(registry, 'packages/core/src/legacy.ts'), {
      registered: true,
      role: 'grant',
      pattern: 'packages/core/src/legacy.ts',
    });
    const projectedSource = JSON.parse(projected.mutation!.content!) as {
      roles: Record<string, string[]>;
    };
    assert.equal(
      Object.values(projectedSource.roles).some((patterns) =>
        patterns.includes('src/legacy.ts'),
      ),
      false,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('path-role projection emits no mutation when one broad role already follows the move', () => {
  const repository = createFixtureRepository();
  try {
    write(repository, 'src/legacy.ts', 'ordinary\n');
    commitAll(repository, 'Add ordinary legacy source');
    const baseCommit = head(repository);
    move(repository, 'src/legacy.ts', 'packages/core/src/legacy.ts');
    commitAll(repository, 'Move ordinary source');

    const projected = projectAuthorityRemapPathRoles({
      repositoryRoot: repository,
      baseCommit,
      moveCommit: head(repository),
      renamePairs: [
        { from: 'src/legacy.ts', to: 'packages/core/src/legacy.ts' },
      ],
    });
    assert.equal(projected.mutation, null);
    assert.deepEqual(projected.roles, [
      {
        from: 'src/legacy.ts',
        to: 'packages/core/src/legacy.ts',
        role: 'ordinary',
        beforePattern: 'src/**',
        afterPattern: 'packages/**',
      },
    ]);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('path-role projection rejects unregistered sources and exact destination conflicts', () => {
  for (const scenario of ['unregistered', 'conflict'] as const) {
    const repository = createFixtureRepository();
    try {
      const from =
        scenario === 'unregistered' ? 'unknown/source.ts' : 'src/legacy.ts';
      const to =
        scenario === 'unregistered'
          ? 'unknown-target/source.ts'
          : 'packages/core/src/legacy.ts';
      write(repository, from, `${scenario}\n`);
      if (scenario === 'conflict') {
        updatePathRoles(repository, (roles) => {
          roles.grant = [from];
          roles.lifecycle = [to];
        });
      }
      commitAll(repository, `Add ${scenario} source`);
      const baseCommit = head(repository);
      move(repository, from, to);
      commitAll(repository, `Move ${scenario} source`);

      assert.throws(
        () =>
          projectAuthorityRemapPathRoles({
            repositoryRoot: repository,
            baseCommit,
            moveCommit: head(repository),
            renamePairs: [{ from, to }],
          }),
        (error) => isWorkflowError(error, 'AUTHORITY_REMAP_INVALID'),
        scenario,
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('check projection rewrites only parser-valid exact argv path tokens', () => {
  const repository = createFixtureRepository();
  try {
    write(repository, 'src/legacy-check.ts', 'export {};\n');
    updateChecks(repository, (checks) => {
      checks['moved-check'] = {
        command: ['node', 'src/legacy-check.ts'],
        destructiveDatabase: false,
      };
    });
    commitAll(repository, 'Add legacy check entrypoint');
    const baseCommit = head(repository);
    move(
      repository,
      'src/legacy-check.ts',
      'packages/core/src/legacy-check.ts',
    );
    commitAll(repository, 'Move check entrypoint');

    const projected = projectAuthorityRemapChecks({
      repositoryRoot: repository,
      baseCommit,
      moveCommit: head(repository),
      renamePairs: [
        {
          from: 'src/legacy-check.ts',
          to: 'packages/core/src/legacy-check.ts',
        },
      ],
    });
    assert.deepEqual(projected.checks, [
      {
        checkId: 'moved-check',
        from: 'src/legacy-check.ts',
        to: 'packages/core/src/legacy-check.ts',
      },
    ]);
    assert.equal(projected.mutation?.path, 'workflow/checks.json');
    const source = JSON.parse(projected.mutation!.content!) as {
      checks: Record<string, { command: string[] }>;
    };
    assert.deepEqual(source.checks['moved-check']?.command, [
      'node',
      'packages/core/src/legacy-check.ts',
    ]);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('check projection is empty without a moved argv token and rejects embedded guesses', () => {
  for (const scenario of ['unchanged', 'embedded'] as const) {
    const repository = createFixtureRepository();
    try {
      write(repository, 'src/legacy-check.ts', 'export {};\n');
      if (scenario === 'embedded') {
        updateChecks(repository, (checks) => {
          checks['embedded-check'] = {
            command: [
              'node',
              'scripts/pass.mjs',
              '--config=src/legacy-check.ts',
            ],
            destructiveDatabase: false,
          };
        });
      }
      commitAll(repository, `Add ${scenario} check source`);
      const baseCommit = head(repository);
      move(
        repository,
        'src/legacy-check.ts',
        'packages/core/src/legacy-check.ts',
      );
      commitAll(repository, `Move ${scenario} check source`);
      const request = {
        repositoryRoot: repository,
        baseCommit,
        moveCommit: head(repository),
        renamePairs: [
          {
            from: 'src/legacy-check.ts',
            to: 'packages/core/src/legacy-check.ts',
          },
        ],
      } as const;

      if (scenario === 'unchanged') {
        assert.equal(projectAuthorityRemapChecks(request).mutation, null);
      } else {
        assert.throws(
          () => projectAuthorityRemapChecks(request),
          (error) => isWorkflowError(error, 'AUTHORITY_REMAP_INVALID'),
        );
      }
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('check projection rejects equivalent and delimited embedded path spellings', () => {
  for (const embedded of [
    './src/legacy-check.ts',
    'other,src/legacy-check.ts',
  ]) {
    const repository = createFixtureRepository();
    try {
      write(repository, 'src/legacy-check.ts', 'export {};\n');
      updateChecks(repository, (checks) => {
        checks['embedded-alias-check'] = {
          command: ['node', 'scripts/pass.mjs', '--config', embedded],
          destructiveDatabase: false,
        };
      });
      commitAll(repository, 'Add embedded alias check source');
      const baseCommit = head(repository);
      move(
        repository,
        'src/legacy-check.ts',
        'packages/core/src/legacy-check.ts',
      );
      commitAll(repository, 'Move embedded alias check source');

      assert.throws(
        () =>
          projectAuthorityRemapChecks({
            repositoryRoot: repository,
            baseCommit,
            moveCommit: head(repository),
            renamePairs: [
              {
                from: 'src/legacy-check.ts',
                to: 'packages/core/src/legacy-check.ts',
              },
            ],
          }),
        (error) => isWorkflowError(error, 'AUTHORITY_REMAP_INVALID'),
        embedded,
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('check projection rejects an invalid pinned registry before rewriting one valid command', () => {
  for (const scenario of ['invalid-id', 'invalid-field'] as const) {
    const repository = createFixtureRepository();
    try {
      write(repository, 'src/legacy-check.ts', 'export {};\n');
      const checksPath = path.join(repository, 'workflow/checks.json');
      const source = JSON.parse(fs.readFileSync(checksPath, 'utf8')) as {
        checks: Record<string, Record<string, unknown>>;
      };
      source.checks['moved-check'] = {
        command: ['node', 'src/legacy-check.ts'],
        destructiveDatabase: false,
      };
      if (scenario === 'invalid-id') {
        source.checks.BAD_ID = {
          command: ['node', 'scripts/pass.mjs'],
          destructiveDatabase: false,
        };
      } else {
        source.checks.fixture!.destructiveDatabase = 'false';
      }
      fs.writeFileSync(checksPath, `${JSON.stringify(source, null, 2)}\n`);
      commitAll(repository, `Add ${scenario} check registry`);
      const baseCommit = head(repository);
      move(
        repository,
        'src/legacy-check.ts',
        'packages/core/src/legacy-check.ts',
      );
      commitAll(repository, `Move ${scenario} check source`);

      assert.throws(
        () =>
          projectAuthorityRemapChecks({
            repositoryRoot: repository,
            baseCommit,
            moveCommit: head(repository),
            renamePairs: [
              {
                from: 'src/legacy-check.ts',
                to: 'packages/core/src/legacy-check.ts',
              },
            ],
          }),
        (error) => isWorkflowError(error, 'AUTHORITY_REMAP_INVALID'),
        scenario,
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('guard projection rewrites active allowedPaths and never touches archive or dot history', () => {
  const repository = createFixtureRepository();
  try {
    removeFixtureActiveGuard(repository);
    write(repository, 'src/legacy.ts', 'guarded\n');
    writeGuard(
      repository,
      'openspec/changes/live-remap/guard.json',
      'live-remap',
      'src/legacy.ts',
    );
    writeGuard(
      repository,
      'openspec/changes/archive/2026-08-20-live-remap/guard.json',
      'live-remap',
      'src/legacy.ts',
    );
    writeGuard(
      repository,
      'openspec/changes/.draft/guard.json',
      '.draft',
      'src/legacy.ts',
    );
    commitAll(repository, 'Add active and historical guards');
    const baseCommit = head(repository);
    const archivePath = path.join(
      repository,
      'openspec/changes/archive/2026-08-20-live-remap/guard.json',
    );
    const archiveBytes = fs.readFileSync(archivePath, 'utf8');
    move(repository, 'src/legacy.ts', 'packages/core/src/legacy.ts');
    commitAll(repository, 'Move guarded source');

    const projected = projectAuthorityRemapGuards({
      repositoryRoot: repository,
      baseCommit,
      moveCommit: head(repository),
      renamePairs: [
        { from: 'src/legacy.ts', to: 'packages/core/src/legacy.ts' },
      ],
    });
    assert.deepEqual(
      projected.guards.map(({ path: guardPath, replacements }) => ({
        path: guardPath,
        replacements,
      })),
      [
        {
          path: 'openspec/changes/live-remap/guard.json',
          replacements: [
            {
              taskId: '1.1',
              from: 'src/legacy.ts',
              to: 'packages/core/src/legacy.ts',
            },
          ],
        },
      ],
    );
    assert.deepEqual(
      (
        JSON.parse(projected.mutations[0]!.content!) as {
          tasks: Record<string, { allowedPaths: string[] }>;
        }
      ).tasks['1.1']?.allowedPaths,
      ['packages/core/src/legacy.ts'],
    );
    assert.equal(fs.readFileSync(archivePath, 'utf8'), archiveBytes);
    assert.equal(
      projected.mutations.some(({ path: mutationPath }) =>
        mutationPath.includes('/archive/'),
      ),
      false,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('guard projection emits no mutations when no active guard references a move', () => {
  const repository = createFixtureRepository();
  try {
    removeFixtureActiveGuard(repository);
    write(repository, 'src/legacy.ts', 'unguarded\n');
    commitAll(repository, 'Add unguarded source');
    const baseCommit = head(repository);
    move(repository, 'src/legacy.ts', 'packages/core/src/legacy.ts');
    commitAll(repository, 'Move unguarded source');

    const projected = projectAuthorityRemapGuards({
      repositoryRoot: repository,
      baseCommit,
      moveCommit: head(repository),
      renamePairs: [
        { from: 'src/legacy.ts', to: 'packages/core/src/legacy.ts' },
      ],
    });
    assert.deepEqual(projected.guards, []);
    assert.deepEqual(projected.mutations, []);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('maintainer policy projection preserves exact and broad authority-path semantics', () => {
  for (const scenario of [
    'exact',
    'broad-cross-root',
    'broad-covered',
  ] as const) {
    const repository = createFixtureRepository();
    try {
      const from =
        scenario === 'broad-covered' ? 'src/legacy/entry.ts' : 'src/legacy.ts';
      const to =
        scenario === 'broad-covered'
          ? 'src/relocated/entry.ts'
          : 'packages/core/src/legacy.ts';
      write(repository, from, `${scenario}\n`);
      writeMaintainerPolicy(repository, (policy) => {
        policy.bootstrapEligiblePaths =
          scenario === 'exact' ? [from] : ['src/**'];
        policy.sealedImmutablePaths =
          scenario === 'exact' ? [from] : ['src/**'];
      });
      commitAll(repository, `Add ${scenario} authority path`);
      const baseCommit = head(repository);
      move(repository, from, to);
      commitAll(repository, `Move ${scenario} authority path`);

      const projected = projectAuthorityRemapMaintainerPolicy({
        repositoryRoot: repository,
        baseCommit,
        moveCommit: head(repository),
        renamePairs: [{ from, to }],
      });

      if (scenario === 'broad-covered') {
        assert.equal(projected.mutation, null);
        continue;
      }
      const policy = parseMaintainerPolicy(
        JSON.parse(projected.mutation!.content),
      );
      const expected = scenario === 'exact' ? [to] : [to, 'src/**'].sort();
      assert.deepEqual(policy.bootstrapEligiblePaths, expected);
      assert.deepEqual(policy.sealedImmutablePaths, expected);
      assert.deepEqual(projected.paths, [
        {
          field: 'bootstrapEligiblePaths',
          from,
          to,
        },
        {
          field: 'sealedImmutablePaths',
          from,
          to,
        },
      ]);
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('maintainer policy projection rejects path-authority expansion at the destination', () => {
  const repository = createFixtureRepository();
  try {
    write(repository, 'src/legacy.ts', 'not eligible\n');
    writeMaintainerPolicy(repository, (policy) => {
      policy.bootstrapEligiblePaths = ['packages/**'];
      policy.sealedImmutablePaths = [];
    });
    commitAll(repository, 'Add non-authority source');
    const baseCommit = head(repository);
    move(repository, 'src/legacy.ts', 'packages/core/src/legacy.ts');
    commitAll(repository, 'Move source into authority scope');

    assert.throws(
      () =>
        projectAuthorityRemapMaintainerPolicy({
          repositoryRoot: repository,
          baseCommit,
          moveCommit: head(repository),
          renamePairs: [
            {
              from: 'src/legacy.ts',
              to: 'packages/core/src/legacy.ts',
            },
          ],
        }),
      (error) => isWorkflowError(error, 'AUTHORITY_REMAP_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('maintainer profile projection preserves effective allow and forbidden roles', () => {
  const repository = createFixtureRepository();
  try {
    write(repository, 'src/legacy.ts', 'implementation\n');
    write(repository, 'secret/legacy.ts', 'forbidden\n');
    writeMaintainerProfiles(repository, {
      implementationPaths: ['src/**'],
      forbiddenPaths: ['secret/legacy.ts'],
    });
    commitAll(repository, 'Add profile-classified sources');
    const baseCommit = head(repository);
    move(repository, 'src/legacy.ts', 'packages/core/src/legacy.ts');
    move(repository, 'secret/legacy.ts', 'relocated/secret.ts');
    commitAll(repository, 'Move profile-classified sources');

    const projected = projectAuthorityRemapProfiles({
      repositoryRoot: repository,
      baseCommit,
      moveCommit: head(repository),
      renamePairs: [
        { from: 'src/legacy.ts', to: 'packages/core/src/legacy.ts' },
        { from: 'secret/legacy.ts', to: 'relocated/secret.ts' },
      ],
    });
    const document = JSON.parse(projected.mutation!.content) as {
      profiles: Record<string, unknown>;
    };
    const profile = parseCapabilityProfile(document.profiles['remap-profile']);
    assert.deepEqual(profile.implementationPaths, [
      'packages/core/src/legacy.ts',
      'src/**',
    ]);
    assert.deepEqual(profile.forbiddenPaths, ['relocated/secret.ts']);
    assert.equal(
      classifyFileRole(profile, 'packages/core/src/legacy.ts'),
      'implementation',
    );
    assert.equal(classifyFileRole(profile, 'relocated/secret.ts'), 'forbidden');
    assert.deepEqual(
      projected.profiles.map(
        ({ profileId, from, to, beforeRole, afterRole }) => ({
          profileId,
          from,
          to,
          beforeRole,
          afterRole,
        }),
      ),
      [
        {
          profileId: 'remap-profile',
          from: 'secret/legacy.ts',
          to: 'relocated/secret.ts',
          beforeRole: 'forbidden',
          afterRole: 'forbidden',
        },
        {
          profileId: 'remap-profile',
          from: 'src/legacy.ts',
          to: 'packages/core/src/legacy.ts',
          beforeRole: 'implementation',
          afterRole: 'implementation',
        },
      ],
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('authority remap composes one manifest and one existing authority-plan intent without ceremony fields', () => {
  const repository = createFixtureRepository();
  try {
    removeFixtureActiveGuard(repository);
    write(repository, 'src/legacy.ts', 'composed\n');
    writeMaintainerPolicy(repository, (policy) => {
      policy.bootstrapEligiblePaths = ['packages/**', 'src/**'];
      policy.sealedImmutablePaths = [];
    });
    writeMaintainerProfiles(repository, {
      implementationPaths: ['packages/**', 'src/**'],
      policyPaths: [
        'openspec/changes/live-remap/guard.json',
        'workflow/maintainer-policy.json',
        'workflow/maintainer-profiles.json',
        'workflow/path-roles.json',
      ],
    });
    updatePathRoles(repository, (roles) => {
      roles.grant = ['src/legacy.ts'];
    });
    updateChecks(repository, (checks) => {
      checks['moved-check'] = {
        command: ['node', 'src/legacy.ts'],
        destructiveDatabase: false,
      };
    });
    writeGuard(
      repository,
      'openspec/changes/live-remap/guard.json',
      'live-remap',
      'src/legacy.ts',
    );
    commitAll(repository, 'Add composed remap fixture');
    const baseCommit = head(repository);
    move(repository, 'src/legacy.ts', 'packages/core/src/legacy.ts');
    commitAll(repository, 'Move composed remap fixture');
    const request = {
      repositoryRoot: repository,
      baseCommit,
      moveCommit: head(repository),
      renamePairs: [
        { from: 'src/legacy.ts', to: 'packages/core/src/legacy.ts' },
      ],
      authorityPlan: {
        changeId: 'live-remap',
        taskId: '1.1',
        profileId: 'remap-profile',
        reason: 'Project exact live authority paths for one move phase.',
        message: 'Project authority paths for mechanical move',
      },
    } as const;

    const projected = projectAuthorityRemap(request);
    assert.deepEqual(projectAuthorityRemap(request), projected);
    assert.equal(
      projected.manifest.kind,
      'workflow.authority-remap-manifest.v1',
    );
    assert.match(projected.manifest.manifestDigest, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(
      projected.manifest.projections.map(
        ({ path: projectedPath }) => projectedPath,
      ),
      [
        'openspec/changes/live-remap/guard.json',
        'workflow/checks.json',
        'workflow/path-roles.json',
      ],
    );
    assert.deepEqual(projected.manifest.moves[0]?.role, {
      name: 'grant',
      beforePattern: 'src/legacy.ts',
      afterPattern: 'packages/core/src/legacy.ts',
    });
    assert.deepEqual(
      projected.intent?.mutations.map(({ path: mutationPath }) => mutationPath),
      projected.manifest.projections.map(
        ({ path: projectedPath }) => projectedPath,
      ),
    );
    assert.deepEqual(projected.intent?.externalEffects, []);
    assert.deepEqual(projected.intent?.evidenceWaivers, []);
    assert.equal('grant' in (projected.intent ?? {}), false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('authority remap does not mint an empty authority intent for a policy-neutral move', () => {
  const repository = createFixtureRepository();
  try {
    removeFixtureActiveGuard(repository);
    write(repository, 'src/legacy.ts', 'neutral\n');
    writeMaintainerPolicy(repository, (policy) => {
      policy.bootstrapEligiblePaths = ['packages/**', 'src/**'];
      policy.sealedImmutablePaths = [];
    });
    writeMaintainerProfiles(repository, {
      implementationPaths: ['packages/**', 'src/**'],
    });
    commitAll(repository, 'Add policy-neutral source');
    const baseCommit = head(repository);
    move(repository, 'src/legacy.ts', 'packages/core/src/legacy.ts');
    commitAll(repository, 'Move policy-neutral source');

    const projected = projectAuthorityRemap({
      repositoryRoot: repository,
      baseCommit,
      moveCommit: head(repository),
      renamePairs: [
        { from: 'src/legacy.ts', to: 'packages/core/src/legacy.ts' },
      ],
      authorityPlan: {
        changeId: 'neutral-remap',
        taskId: '1.1',
        profileId: 'workflow-engine-root-one-shot',
        reason: 'Prove one policy-neutral mechanical move phase.',
        message: 'Prove policy-neutral mechanical move',
      },
    });
    assert.deepEqual(projected.manifest.projections, []);
    assert.equal(projected.manifest.authorityPlanIntentDigest, null);
    assert.equal(projected.intent, null);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('engine source moves require the ordered closure regeneration chain instead of appearing policy-neutral', () => {
  const repository = createFixtureRepository();
  try {
    removeFixtureActiveGuard(repository);
    const from = 'packages/workflow-engine/src/legacy.ts';
    const to = 'packages/workflow-engine/src/modules/legacy.ts';
    write(repository, from, 'export const legacy = true;\n');
    writeMaintainerPolicy(repository, (policy) => {
      policy.bootstrapEligiblePaths = ['packages/**'];
      policy.sealedImmutablePaths = [];
    });
    writeMaintainerProfiles(repository, {
      implementationPaths: ['packages/**'],
    });
    commitAll(repository, 'Add engine source before remap');
    const baseCommit = head(repository);
    move(repository, from, to);
    commitAll(repository, 'Move engine source mechanically');
    const request = {
      repositoryRoot: repository,
      baseCommit,
      moveCommit: head(repository),
      renamePairs: [{ from, to }],
      authorityPlan: {
        changeId: 'engine-source-remap',
        taskId: '1.1',
        profileId: 'remap-profile',
        reason:
          'Regenerate exact protected closures after an engine source move.',
        message: 'Regenerate authority closures after source move',
      },
    } as const;

    const projected = projectAuthorityRemap(request);
    assert.equal(projected.status, 'requires-regeneration');
    assert.equal(projected.intent, null);
    assert.deepEqual(projected.regeneration?.steps, [
      'built-in-engine-closure',
      'harness-bootstrap-runtime',
      'protected-capabilities',
    ]);
    assert.equal(
      projected.regeneration?.mechanicalProofDigest,
      projected.manifest.mechanicalProofDigest,
    );
    assert.equal(projected.regeneration?.moveTree, projected.manifest.moveTree);
    assert.equal(
      projected.manifest.regenerationDescriptorDigest,
      projected.regeneration?.descriptorDigest,
    );
    assert.match(
      projected.regeneration?.descriptorDigest ?? '',
      /^sha256:[0-9a-f]{64}$/,
    );

    write(repository, 'dirty-worktree-only.ts', 'ignored\n');
    assert.deepEqual(projectAuthorityRemap(request), projected);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('workspace package source moves use the pinned v2 closure roots for regeneration', () => {
  const repository = createFixtureRepository();
  try {
    removeFixtureActiveGuard(repository);
    const from = 'packages/core/src/legacy.ts';
    const to = 'packages/core/src/modules/legacy.ts';
    write(repository, from, 'export const legacy = true;\n');
    write(
      repository,
      'packages/workflow-engine/bootstrap/built-in-engine-closure.json',
      `${JSON.stringify({
        kind: 'built-in-engine-closure-manifest.v2',
        entrypoint: 'src/cli.ts',
        scope: 'workspace-runtime-source-closure',
        packages: [
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
        ],
        files: [],
      })}\n`,
    );
    writeMaintainerPolicy(repository, (policy) => {
      policy.bootstrapEligiblePaths = ['packages/**'];
      policy.sealedImmutablePaths = [];
    });
    writeMaintainerProfiles(repository, {
      implementationPaths: ['packages/**'],
    });
    commitAll(repository, 'Add workspace package source before remap');
    const baseCommit = head(repository);
    move(repository, from, to);
    commitAll(repository, 'Move workspace package source mechanically');

    const projected = projectAuthorityRemap({
      repositoryRoot: repository,
      baseCommit,
      moveCommit: head(repository),
      renamePairs: [{ from, to }],
      authorityPlan: {
        changeId: 'workspace-source-remap',
        taskId: '1.1',
        profileId: 'remap-profile',
        reason: 'Regenerate exact workspace source closures after a move.',
        message: 'Regenerate workspace source closures',
      },
    });
    assert.equal(projected.status, 'requires-regeneration');
    assert.deepEqual(projected.regeneration?.steps, [
      'built-in-engine-closure',
      'harness-bootstrap-runtime',
      'protected-capabilities',
    ]);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('protected closure member moves require regeneration even when they are outside engine src', () => {
  const repository = createFixtureRepository();
  try {
    removeFixtureActiveGuard(repository);
    const from =
      'packages/workflow-engine/bootstrap/generate-protected-capabilities.ts';
    const to =
      'packages/workflow-engine/bootstrap/generate-protected-capabilities-v2.ts';
    write(repository, from, 'export const generator = true;\n');
    fs.copyFileSync(
      path.join(sourceRepositoryRoot, 'workflow/protected-capabilities.json'),
      path.join(repository, 'workflow/protected-capabilities.json'),
    );
    writeMaintainerPolicy(repository, (policy) => {
      policy.bootstrapEligiblePaths = ['packages/**'];
      policy.sealedImmutablePaths = [];
    });
    writeMaintainerProfiles(repository, {
      implementationPaths: ['packages/**'],
    });
    commitAll(repository, 'Add protected closure member before remap');
    const baseCommit = head(repository);
    move(repository, from, to);
    commitAll(repository, 'Move protected closure member mechanically');

    const projected = projectAuthorityRemap({
      repositoryRoot: repository,
      baseCommit,
      moveCommit: head(repository),
      renamePairs: [{ from, to }],
      authorityPlan: {
        changeId: 'protected-closure-remap',
        taskId: '1.1',
        profileId: 'remap-profile',
        reason: 'Regenerate exact protected closure membership after a move.',
        message: 'Regenerate protected closure membership',
      },
    });
    assert.equal(projected.status, 'requires-regeneration');
    assert.deepEqual(projected.regeneration?.affectedMoves, [{ from, to }]);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('reviewed content boundary rejects authority artifacts and non-edit statuses', () => {
  for (const variant of ['authority-artifact', 'added-file'] as const) {
    const repository = createFixtureRepository();
    try {
      removeFixtureActiveGuard(repository);
      const from = 'packages/workflow-engine/src/content-boundary-source.ts';
      const to =
        'packages/workflow-engine/src/modules/content-boundary-source.ts';
      write(repository, from, 'export const contentBoundary = true;\n');
      writeMaintainerPolicy(repository, (policy) => {
        policy.bootstrapEligiblePaths = ['packages/**'];
        policy.sealedImmutablePaths = [];
      });
      writeMaintainerProfiles(repository, {
        implementationPaths: ['packages/**'],
      });
      commitAll(repository, 'Add reviewed-content boundary fixture');
      const baseCommit = head(repository);
      move(repository, from, to);
      commitAll(repository, 'Move reviewed-content boundary fixture');
      const moveCommit = head(repository);
      if (variant === 'authority-artifact') {
        updatePathRoles(repository, (roles) => {
          roles.ordinary = [...(roles.ordinary ?? []), 'docs/**'];
        });
      } else {
        write(
          repository,
          'packages/workflow-engine/src/content-boundary-added.ts',
          'export const added = true;\n',
        );
      }
      commitAll(repository, `Add invalid ${variant} content boundary`);

      assert.throws(
        () =>
          projectAuthorityRemap({
            repositoryRoot: repository,
            baseCommit,
            moveCommit,
            materializationCommit: head(repository),
            renamePairs: [{ from, to }],
            authorityPlan: {
              changeId: `reject-${variant}`,
              taskId: '1.1',
              profileId: 'remap-profile',
              reason: 'Reject an invalid reviewed-content boundary commit.',
              message: 'Reject invalid reviewed content',
            },
          }),
        (error) => isWorkflowError(error, 'AUTHORITY_REMAP_INVALID'),
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('regeneration materializes one exact ready intent and rejects a stale handoff', async () => {
  const container = fs.mkdtempSync(
    path.join(os.tmpdir(), 'authority-remap-materializer-contract-'),
  );
  const repository = path.join(container, 'repository');
  try {
    execFileSync(
      'git',
      [
        'clone',
        '--quiet',
        '--shared',
        '--no-checkout',
        sourceRepositoryRoot,
        repository,
      ],
      { encoding: 'utf8' },
    );
    git(repository, [
      'checkout',
      '--quiet',
      '--detach',
      head(sourceRepositoryRoot),
    ]);
    git(repository, ['config', 'user.email', 'workflow@example.test']);
    git(repository, ['config', 'user.name', 'Workflow Test']);
    const from =
      'packages/workflow-engine/src/modules/t3-materializer-fixture.ts';
    const to =
      'packages/workflow-engine/src/modules/source/t3-materializer-fixture.ts';
    write(repository, from, 'export const t3MaterializerFixture = true;\n');
    const harnessBootstrapPath = path.join(
      repository,
      'packages/workflow-engine/src/harness-bootstrap.ts',
    );
    fs.appendFileSync(
      harnessBootstrapPath,
      "export { t3MaterializerFixture } from './modules/t3-materializer-fixture.ts';\n",
    );
    const regeneratedOutput =
      'packages/workflow-engine/bootstrap/recovery-runtime/src/modules/source/t3-materializer-fixture.js';
    fs.appendFileSync(
      path.join(repository, '.gitignore'),
      [
        '/packages/workflow-engine/bootstrap/built-in-engine-closure.json',
        `/${regeneratedOutput}`,
        `!/${regeneratedOutput}`,
        '',
      ].join('\n'),
    );
    generateBuiltInEngineClosure(repository, '--write');
    generateHarnessBootstrapRuntime(repository, '--write');
    await generateProtectedCapabilitiesManifest(repository, '--write');
    commitAll(repository, 'Add generated-current materializer fixture');
    const baseCommit = head(repository);
    move(repository, from, to);
    commitAll(repository, 'Move materializer fixture mechanically');
    const moveCommit = head(repository);
    fs.writeFileSync(
      harnessBootstrapPath,
      fs
        .readFileSync(harnessBootstrapPath, 'utf8')
        .replace(
          './modules/t3-materializer-fixture.ts',
          './modules/source/t3-materializer-fixture.ts',
        ),
    );
    commitAll(repository, 'Review materializer fixture import rewrite');
    const materializationCommit = head(repository);
    const request = {
      repositoryRoot: repository,
      baseCommit,
      moveCommit,
      materializationCommit,
      renamePairs: [{ from, to }],
      authorityPlan: {
        changeId: 'materialize-remap',
        taskId: '1.1',
        profileId: 'workflow-engine-root-one-shot',
        reason: 'Materialize exact generated artifacts for one move phase.',
        message: 'Materialize authority remap artifacts',
      },
    } as const;
    const pending = projectAuthorityRemap(request);
    assert.equal(pending.status, 'requires-regeneration');

    const materializationRequest = {
      ...request,
      authorityPlan: { ...request.authorityPlan },
      expectedRegenerationDescriptorDigest:
        pending.regeneration!.descriptorDigest,
    };
    const materialization = materializeAuthorityRemap(materializationRequest);
    const mutableAuthorityPlan = materializationRequest.authorityPlan as {
      changeId: string;
      taskId: string;
      profileId: string;
      reason: string;
      message: string;
    };
    mutableAuthorityPlan.changeId = 'INVALID';
    mutableAuthorityPlan.taskId = 'bad';
    mutableAuthorityPlan.reason = '';
    mutableAuthorityPlan.message = '';
    const materialized = await materialization;
    assert.equal(materialized.status, 'ready');
    assert.equal(materialized.regeneration, null);
    assert.equal(
      materialized.manifest.regenerationDescriptorDigest,
      pending.regeneration!.descriptorDigest,
    );
    assert.equal(
      materialized.manifest.authorityPlanIntentDigest === null,
      false,
    );
    assert.match(
      materialized.manifest.authorityPlanIntentDigest ?? '',
      /^sha256:[0-9a-f]{64}$/,
    );
    const mutationPaths = materialized.intent!.mutations.map(
      ({ path }) => path,
    );
    assert.deepEqual(mutationPaths, [...mutationPaths].sort());
    assert.ok(
      mutationPaths.includes(
        'packages/workflow-engine/bootstrap/built-in-engine-closure.json',
      ),
    );
    assert.ok(
      mutationPaths.includes(
        'packages/workflow-engine/bootstrap/built-in-engine-closure-pin.ts',
      ),
    );
    assert.ok(mutationPaths.includes(regeneratedOutput));
    assert.ok(mutationPaths.includes('workflow/protected-capabilities.json'));
    assert.equal(materialized.intent!.changeId, 'materialize-remap');
    assert.equal(materialized.intent!.taskId, '1.1');
    assert.equal(
      materialized.intent!.reason,
      'Materialize exact generated artifacts for one move phase.',
    );
    assert.equal(git(repository, ['status', '--porcelain']), '');

    git(repository, ['commit', '--allow-empty', '-m', 'Advance after move']);
    await assert.rejects(
      materializeAuthorityRemap({
        ...request,
        expectedRegenerationDescriptorDigest:
          pending.regeneration!.descriptorDigest,
      }),
      (error) =>
        error instanceof Error &&
        isWorkflowError(error, 'AUTHORITY_REMAP_INVALID') &&
        error.message.includes('caller HEAD'),
    );
  } finally {
    fs.rmSync(container, { recursive: true, force: true });
  }
});

test('regeneration rejects generated recovery outputs ignored by tracked rules', async () => {
  const container = fs.mkdtempSync(
    path.join(os.tmpdir(), 'authority-remap-ignored-output-contract-'),
  );
  const repository = path.join(container, 'repository');
  try {
    execFileSync(
      'git',
      [
        'clone',
        '--quiet',
        '--shared',
        '--no-checkout',
        sourceRepositoryRoot,
        repository,
      ],
      { encoding: 'utf8' },
    );
    git(repository, [
      'checkout',
      '--quiet',
      '--detach',
      head(sourceRepositoryRoot),
    ]);
    git(repository, ['config', 'user.email', 'workflow@example.test']);
    git(repository, ['config', 'user.name', 'Workflow Test']);
    const from =
      'packages/workflow-engine/src/modules/t3-ignored-output-fixture.ts';
    const to =
      'packages/workflow-engine/src/modules/source/t3-ignored-output-fixture.ts';
    const ignoredOutput =
      'packages/workflow-engine/bootstrap/recovery-runtime/src/modules/source/t3-ignored-output-fixture.js';
    write(repository, from, 'export const t3IgnoredOutputFixture = true;\n');
    const harnessBootstrapPath = path.join(
      repository,
      'packages/workflow-engine/src/harness-bootstrap.ts',
    );
    fs.appendFileSync(
      harnessBootstrapPath,
      "export { t3IgnoredOutputFixture } from './modules/t3-ignored-output-fixture.ts';\n",
    );
    fs.appendFileSync(
      path.join(repository, '.gitignore'),
      `/${ignoredOutput}\n`,
    );
    generateBuiltInEngineClosure(repository, '--write');
    generateHarnessBootstrapRuntime(repository, '--write');
    await generateProtectedCapabilitiesManifest(repository, '--write');
    commitAll(repository, 'Add generated-current ignored-output fixture');
    const baseCommit = head(repository);
    move(repository, from, to);
    commitAll(repository, 'Move ignored-output fixture mechanically');
    const moveCommit = head(repository);
    fs.writeFileSync(
      harnessBootstrapPath,
      fs
        .readFileSync(harnessBootstrapPath, 'utf8')
        .replace(
          './modules/t3-ignored-output-fixture.ts',
          './modules/source/t3-ignored-output-fixture.ts',
        ),
    );
    commitAll(repository, 'Review ignored-output fixture import rewrite');
    const materializationCommit = head(repository);
    const request = {
      repositoryRoot: repository,
      baseCommit,
      moveCommit,
      materializationCommit,
      renamePairs: [{ from, to }],
      authorityPlan: {
        changeId: 'reject-ignored-generated-output',
        taskId: '1.1',
        profileId: 'workflow-engine-root-one-shot',
        reason: 'Reject generated output omitted by tracked ignore rules.',
        message: 'Reject ignored generated output',
      },
    } as const;
    const pending = projectAuthorityRemap(request);
    assert.equal(pending.status, 'requires-regeneration');

    await assert.rejects(
      materializeAuthorityRemap({
        ...request,
        expectedRegenerationDescriptorDigest:
          pending.regeneration!.descriptorDigest,
      }),
      (error) =>
        error instanceof Error &&
        isWorkflowError(error, 'AUTHORITY_REMAP_INVALID') &&
        error.message.includes(ignoredOutput),
    );
  } finally {
    fs.rmSync(container, { recursive: true, force: true });
  }
});

test('regeneration rejects pre-existing generated drift in the pinned base commit', async () => {
  const container = fs.mkdtempSync(
    path.join(os.tmpdir(), 'authority-remap-stale-base-contract-'),
  );
  const repository = path.join(container, 'repository');
  try {
    execFileSync(
      'git',
      [
        'clone',
        '--quiet',
        '--shared',
        '--no-checkout',
        sourceRepositoryRoot,
        repository,
      ],
      { encoding: 'utf8' },
    );
    git(repository, [
      'checkout',
      '--quiet',
      '--detach',
      head(sourceRepositoryRoot),
    ]);
    git(repository, ['config', 'user.email', 'workflow@example.test']);
    git(repository, ['config', 'user.name', 'Workflow Test']);

    const stale =
      'packages/workflow-engine/src/modules/t3-unrelated-stale-base.ts';
    const from = 'packages/workflow-engine/src/modules/t3-stale-base-move.ts';
    const to =
      'packages/workflow-engine/src/modules/source/t3-stale-base-move.ts';
    write(repository, stale, 'export const unrelatedStaleBase = true;\n');
    write(repository, from, 'export const staleBaseMove = true;\n');
    commitAll(repository, 'Create intentionally stale generated base');
    const baseCommit = head(repository);
    move(repository, from, to);
    commitAll(repository, 'Move fixture without laundering stale base');
    const moveCommit = head(repository);
    const pending = projectAuthorityRemap({
      repositoryRoot: repository,
      baseCommit,
      moveCommit,
      renamePairs: [{ from, to }],
      authorityPlan: {
        changeId: 'reject-stale-generated-base',
        taskId: '1.1',
        profileId: 'workflow-engine-root-one-shot',
        reason:
          'Reject unrelated generated drift before remap materialization.',
        message: 'Reject stale generated base',
      },
    });
    assert.equal(pending.status, 'requires-regeneration');

    await assert.rejects(
      materializeAuthorityRemap({
        repositoryRoot: repository,
        baseCommit,
        moveCommit,
        renamePairs: [{ from, to }],
        authorityPlan: {
          changeId: 'reject-stale-generated-base',
          taskId: '1.1',
          profileId: 'workflow-engine-root-one-shot',
          reason:
            'Reject unrelated generated drift before remap materialization.',
          message: 'Reject stale generated base',
        },
        expectedRegenerationDescriptorDigest:
          pending.regeneration!.descriptorDigest,
      }),
      (error) =>
        error instanceof Error &&
        isWorkflowError(error, 'AUTHORITY_REMAP_INVALID') &&
        error.message.includes('pinned base generated artifacts are stale'),
    );
  } finally {
    fs.rmSync(container, { recursive: true, force: true });
  }
});

test('regeneration rejects tracked attributes that can transform pinned blob bytes', async () => {
  const repository = createFixtureRepository();
  try {
    removeFixtureActiveGuard(repository);
    const from = 'packages/workflow-engine/src/attribute-source.ts';
    const to = 'packages/workflow-engine/src/modules/attribute-source.ts';
    write(repository, '.gitattributes', '*.ts filter=audit text eol=crlf\n');
    write(repository, from, 'export const attributeSource = true;\n');
    writeMaintainerPolicy(repository, (policy) => {
      policy.bootstrapEligiblePaths = ['packages/**'];
      policy.sealedImmutablePaths = [];
    });
    writeMaintainerProfiles(repository, {
      implementationPaths: ['packages/**'],
    });
    commitAll(repository, 'Add transforming attributes before remap');
    const baseCommit = head(repository);
    move(repository, from, to);
    commitAll(repository, 'Move source under transforming attributes');
    const moveCommit = head(repository);
    const marker = path.join(path.dirname(repository), 'filter-executed');
    const filterScript = path.join(path.dirname(repository), 'filter.mjs');
    fs.writeFileSync(
      filterScript,
      [
        "import fs from 'node:fs';",
        `fs.writeFileSync(${JSON.stringify(marker)}, 'executed\\n');`,
        'process.stdin.pipe(process.stdout);',
        '',
      ].join('\n'),
    );
    git(repository, [
      'config',
      'filter.audit.clean',
      `${process.execPath} ${filterScript}`,
    ]);
    git(repository, ['config', 'filter.audit.required', 'true']);
    const movedPath = path.join(repository, to);
    const movedStats = fs.statSync(movedPath);
    fs.utimesSync(
      movedPath,
      movedStats.atime,
      new Date(movedStats.mtimeMs + 1_000),
    );
    const request = {
      repositoryRoot: repository,
      baseCommit,
      moveCommit,
      renamePairs: [{ from, to }],
      authorityPlan: {
        changeId: 'reject-transforming-attributes',
        taskId: '1.1',
        profileId: 'remap-profile',
        reason: 'Reject worktree byte transforms during exact materialization.',
        message: 'Reject transforming Git attributes',
      },
    } as const;
    const pending = projectAuthorityRemap(request);
    assert.equal(pending.status, 'requires-regeneration');

    await assert.rejects(
      materializeAuthorityRemap({
        ...request,
        expectedRegenerationDescriptorDigest:
          pending.regeneration!.descriptorDigest,
      }),
      (error) =>
        error instanceof Error &&
        isWorkflowError(error, 'AUTHORITY_REMAP_INVALID') &&
        error.message.includes('tracked .gitattributes'),
    );
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('regeneration rejects hidden caller index flags before reading materialization inputs', async () => {
  const repository = createFixtureRepository();
  try {
    removeFixtureActiveGuard(repository);
    const from = 'packages/workflow-engine/src/hidden-index-source.ts';
    const to = 'packages/workflow-engine/src/modules/hidden-index-source.ts';
    write(repository, from, 'export const hiddenIndexSource = true;\n');
    writeMaintainerPolicy(repository, (policy) => {
      policy.bootstrapEligiblePaths = ['packages/**'];
      policy.sealedImmutablePaths = [];
    });
    writeMaintainerProfiles(repository, {
      implementationPaths: ['packages/**'],
    });
    commitAll(repository, 'Add source before hidden-index remap');
    const baseCommit = head(repository);
    move(repository, from, to);
    commitAll(repository, 'Move source before hidden-index remap');
    const moveCommit = head(repository);
    git(repository, [
      'update-index',
      '--assume-unchanged',
      'workflow/path-roles.json',
    ]);
    assert.equal(git(repository, ['status', '--porcelain']), '');
    const request = {
      repositoryRoot: repository,
      baseCommit,
      moveCommit,
      renamePairs: [{ from, to }],
      authorityPlan: {
        changeId: 'reject-hidden-index-flags',
        taskId: '1.1',
        profileId: 'remap-profile',
        reason: 'Reject hidden caller index state before materialization.',
        message: 'Reject hidden index flags',
      },
    } as const;
    const pending = projectAuthorityRemap(request);
    assert.equal(pending.status, 'requires-regeneration');

    await assert.rejects(
      materializeAuthorityRemap({
        ...request,
        expectedRegenerationDescriptorDigest:
          pending.regeneration!.descriptorDigest,
      }),
      (error) =>
        error instanceof Error &&
        isWorkflowError(error, 'AUTHORITY_REMAP_INVALID') &&
        error.message.includes('hidden index flags'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('closure generators reject symlinked package boundaries without writing or deleting outside them', () => {
  const container = fs.mkdtempSync(
    path.join(os.tmpdir(), 'closure-generator-boundary-contract-'),
  );
  try {
    const candidate = path.join(container, 'candidate');
    const packageRoot = path.join(candidate, 'packages/workflow-engine');
    const externalBootstrap = path.join(container, 'external-bootstrap');
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.mkdirSync(externalBootstrap, { recursive: true });
    fs.copyFileSync(
      path.join(sourceRepositoryRoot, 'packages/workflow-engine/package.json'),
      path.join(packageRoot, 'package.json'),
    );
    fs.symlinkSync(
      path.join(sourceRepositoryRoot, 'packages/workflow-engine/src'),
      path.join(packageRoot, 'src'),
      'dir',
    );
    fs.symlinkSync(
      externalBootstrap,
      path.join(packageRoot, 'bootstrap'),
      'dir',
    );
    const sentinel = path.join(
      externalBootstrap,
      'recovery-runtime.previous/sentinel',
    );
    write(candidate, path.relative(candidate, sentinel), 'preserve\n');

    assert.throws(() => renderBuiltInEngineClosure(candidate));
    assert.throws(() => generateBuiltInEngineClosure(candidate, '--write'));
    assert.throws(() => generateHarnessBootstrapRuntime(candidate, '--write'));
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'preserve\n');
    assert.equal(
      fs.existsSync(
        path.join(externalBootstrap, 'built-in-engine-closure.json'),
      ),
      false,
    );
  } finally {
    fs.rmSync(container, { recursive: true, force: true });
  }
});

test('harness renderer never executes a candidate-owned compiler and returns immutable encodings', () => {
  const container = fs.mkdtempSync(
    path.join(os.tmpdir(), 'closure-generator-toolchain-contract-'),
  );
  try {
    const packageRoot = path.join(container, 'packages/workflow-engine');
    fs.mkdirSync(path.join(packageRoot, 'src'), { recursive: true });
    fs.mkdirSync(path.join(packageRoot, 'bootstrap'), { recursive: true });
    write(
      container,
      'packages/workflow-engine/package.json',
      '{"name":"@expense/workflow-engine","type":"module"}\n',
    );
    write(
      container,
      'packages/workflow-engine/src/harness-bootstrap.ts',
      'export const fixture = true;\n',
    );
    generateBuiltInEngineClosure(container, '--write');
    const marker = path.join(container, 'candidate-tsc-executed');
    const preloadMarker = path.join(container, 'node-options-executed');
    const preload = path.join(container, 'poisoned-node-options.cjs');
    fs.writeFileSync(
      preload,
      `require('node:fs').writeFileSync(${JSON.stringify(preloadMarker)}, 'executed\\n');\n`,
    );
    const fakeTsc = path.join(container, 'node_modules/.bin/tsc');
    write(
      container,
      'node_modules/.bin/tsc',
      `#!/bin/sh\ntouch '${marker}'\nexit 1\n`,
    );
    fs.chmodSync(fakeTsc, 0o755);

    let rendered: ReturnType<typeof renderHarnessBootstrapRuntime> | null =
      null;
    const originalNodeOptions = process.env.NODE_OPTIONS;
    try {
      process.env.NODE_OPTIONS = `--require=${preload}`;
      rendered = renderHarnessBootstrapRuntime(container);
    } finally {
      if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = originalNodeOptions;
    }
    assert.equal(fs.existsSync(marker), false);
    assert.equal(fs.existsSync(preloadMarker), false);
    assert.notEqual(rendered, null);
    const first = rendered!.runtimeFiles[0] as unknown as {
      contentBase64?: unknown;
    };
    assert.equal(typeof first.contentBase64, 'string');
  } finally {
    fs.rmSync(container, { recursive: true, force: true });
  }
});

test('harness generator rejects linked metadata outputs without overwriting external bytes', () => {
  const container = fs.mkdtempSync(
    path.join(os.tmpdir(), 'closure-generator-output-contract-'),
  );
  try {
    fs.mkdirSync(path.join(container, 'packages/workflow-engine/src'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(container, 'packages/workflow-engine/bootstrap'), {
      recursive: true,
    });
    write(
      container,
      'packages/workflow-engine/package.json',
      '{"name":"@expense/workflow-engine","type":"module"}\n',
    );
    write(
      container,
      'packages/workflow-engine/src/harness-bootstrap.ts',
      'export const fixture = true;\n',
    );
    generateBuiltInEngineClosure(container, '--write');
    const external = path.join(container, 'external-manifest-sentinel');
    fs.writeFileSync(external, 'preserve-external-bytes\n');
    fs.symlinkSync(
      external,
      path.join(
        container,
        'packages/workflow-engine/bootstrap/harness-bootstrap-dependency-closure.json',
      ),
    );

    assert.throws(() => generateHarnessBootstrapRuntime(container, '--write'));
    assert.equal(
      fs.readFileSync(external, 'utf8'),
      'preserve-external-bytes\n',
    );
  } finally {
    fs.rmSync(container, { recursive: true, force: true });
  }
});

test('authority remap rejects an intent that its pinned trust-base profile cannot authorize', () => {
  const repository = createFixtureRepository();
  try {
    removeFixtureActiveGuard(repository);
    write(repository, 'src/legacy.ts', 'restricted\n');
    writeMaintainerPolicy(repository, (policy) => {
      policy.bootstrapEligiblePaths = ['packages/**', 'src/**'];
      policy.sealedImmutablePaths = [];
    });
    writeMaintainerProfiles(repository, {
      implementationPaths: ['packages/**', 'src/**'],
    });
    updatePathRoles(repository, (roles) => {
      roles.grant = ['src/legacy.ts'];
    });
    commitAll(repository, 'Add insufficient remap profile');
    const baseCommit = head(repository);
    move(repository, 'src/legacy.ts', 'packages/core/src/legacy.ts');
    commitAll(repository, 'Move restricted path');

    assert.throws(
      () =>
        projectAuthorityRemap({
          repositoryRoot: repository,
          baseCommit,
          moveCommit: head(repository),
          renamePairs: [
            { from: 'src/legacy.ts', to: 'packages/core/src/legacy.ts' },
          ],
          authorityPlan: {
            changeId: 'restricted-remap',
            taskId: '1.1',
            profileId: 'remap-profile',
            reason: 'Reject an authority projection outside its trust profile.',
            message: 'Reject unauthorized authority projection',
          },
        }),
      (error: unknown) =>
        isWorkflowError(error, 'AUTHORITY_REMAP_INVALID') &&
        error instanceof Error &&
        error.message.includes('workflow/path-roles.json'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('authority remap fails closed when a move hits a code-owned projection endpoint', () => {
  for (const endpoint of ['source', 'target', 'protected-loader'] as const) {
    const repository = createFixtureRepository();
    try {
      removeFixtureActiveGuard(repository);
      const from =
        endpoint === 'source'
          ? 'docs/CURRENT_AND_NEXT_STEPS.md'
          : endpoint === 'protected-loader'
            ? 'packages/workflow-engine/src/adapters/consumer/expense-app/work-registry/protected-capabilities.ts'
            : 'docs/source-handoff.md';
      const to =
        endpoint === 'source'
          ? 'docs/relocated-handoff.md'
          : endpoint === 'protected-loader'
            ? 'packages/workflow-engine/src/adapters/consumer/expense-app/work-registry/protected-capabilities-relocated.ts'
            : 'docs/CURRENT_AND_NEXT_STEPS.md';
      write(repository, from, 'generated handoff\n');
      commitAll(repository, `Add ${endpoint} projection endpoint`);
      const baseCommit = head(repository);
      move(repository, from, to);
      commitAll(repository, `Move ${endpoint} projection endpoint`);

      assert.throws(
        () =>
          projectAuthorityRemap({
            repositoryRoot: repository,
            baseCommit,
            moveCommit: head(repository),
            renamePairs: [{ from, to }],
            authorityPlan: {
              changeId: 'projection-remap',
              taskId: '1.1',
              profileId: 'unused-profile',
              reason: 'Reject an unsupported engine projection remap endpoint.',
              message: 'Reject projection registry remap',
            },
          }),
        (error) => isWorkflowError(error, 'AUTHORITY_REMAP_INVALID'),
        endpoint,
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('mechanical move proof rejects content edits and executable-bit changes', () => {
  for (const mutation of ['content', 'mode'] as const) {
    const repository = createFixtureRepository();
    try {
      write(repository, 'src/legacy.ts', 'original\n');
      commitAll(repository, 'Add legacy source');
      const baseCommit = head(repository);
      move(repository, 'src/legacy.ts', 'packages/core/src/legacy.ts');
      if (mutation === 'content') {
        fs.appendFileSync(
          path.join(repository, 'packages/core/src/legacy.ts'),
          'edited\n',
        );
      } else {
        fs.chmodSync(
          path.join(repository, 'packages/core/src/legacy.ts'),
          0o755,
        );
      }
      commitAll(repository, `Move with ${mutation} mutation`);

      assert.throws(
        () =>
          verifyMechanicalMovePhase({
            repositoryRoot: repository,
            baseCommit,
            moveCommit: head(repository),
            renamePairs: [
              { from: 'src/legacy.ts', to: 'packages/core/src/legacy.ts' },
            ],
          }),
        (error) => isWorkflowError(error, 'AUTHORITY_REMAP_INVALID'),
        mutation,
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('mechanical move proof rejects a target that aliases an untouched tree path by case', () => {
  const repository = createFixtureRepository();
  try {
    write(repository, 'src/legacy.ts', 'same bytes\n');
    write(repository, 'packages/Core.ts', 'untouched\n');
    commitAll(repository, 'Add case-alias fixture');
    const baseCommit = head(repository);
    const objectId = git(repository, [
      'rev-parse',
      `${baseCommit}:src/legacy.ts`,
    ]).trim();
    git(repository, ['config', 'core.ignorecase', 'false']);
    git(repository, ['read-tree', baseCommit]);
    git(repository, ['update-index', '--force-remove', 'src/legacy.ts']);
    git(repository, [
      'update-index',
      '--add',
      '--cacheinfo',
      `100644,${objectId},packages/core.ts`,
    ]);
    const moveTree = git(repository, ['write-tree']).trim();
    const moveCommit = git(repository, [
      'commit-tree',
      moveTree,
      '-p',
      baseCommit,
      '-m',
      'Move into a case-alias collision',
    ]).trim();

    assert.throws(
      () =>
        verifyMechanicalMovePhase({
          repositoryRoot: repository,
          baseCommit,
          moveCommit,
          renamePairs: [{ from: 'src/legacy.ts', to: 'packages/core.ts' }],
        }),
      (error) => isWorkflowError(error, 'AUTHORITY_REMAP_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('mechanical move proof rejects undeclared or non-move changes', () => {
  const repository = createFixtureRepository();
  try {
    write(repository, 'src/a.ts', 'a\n');
    write(repository, 'src/b.ts', 'b\n');
    commitAll(repository, 'Add legacy sources');
    const baseCommit = head(repository);

    move(repository, 'src/a.ts', 'packages/core/src/a.ts');
    move(repository, 'src/b.ts', 'packages/core/src/b.ts');
    fs.appendFileSync(path.join(repository, 'package.json'), ' \n');
    commitAll(repository, 'Mix moves with another edit');
    const moveCommit = head(repository);

    assert.throws(
      () =>
        verifyMechanicalMovePhase({
          repositoryRoot: repository,
          baseCommit,
          moveCommit,
          renamePairs: [{ from: 'src/a.ts', to: 'packages/core/src/a.ts' }],
        }),
      (error) => isWorkflowError(error, 'AUTHORITY_REMAP_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('mechanical move proof rejects symbolic, abbreviated, stale, colliding, and unsafe inputs', () => {
  const repository = createFixtureRepository();
  try {
    write(repository, 'src/a.ts', 'a\n');
    write(repository, 'src/b.ts', 'b\n');
    commitAll(repository, 'Add legacy sources');
    const baseCommit = head(repository);
    move(repository, 'src/a.ts', 'packages/core/src/a.ts');
    commitAll(repository, 'Move one source');
    const moveCommit = head(repository);
    const validPair = {
      from: 'src/a.ts',
      to: 'packages/core/src/a.ts',
    };
    const invalidRequests = [
      { baseCommit: 'HEAD', moveCommit, renamePairs: [validPair] },
      {
        baseCommit: baseCommit.slice(0, 12),
        moveCommit,
        renamePairs: [validPair],
      },
      { baseCommit, moveCommit: baseCommit, renamePairs: [validPair] },
      {
        baseCommit,
        moveCommit,
        renamePairs: [validPair, { ...validPair, to: 'other/a.ts' }],
      },
      {
        baseCommit,
        moveCommit,
        renamePairs: [validPair, { from: 'src/b.ts', to: validPair.to }],
      },
      {
        baseCommit,
        moveCommit,
        renamePairs: [
          { from: 'src/a.ts', to: 'src/b.ts' },
          { from: 'src/b.ts', to: 'packages/core/src/b.ts' },
        ],
      },
      {
        baseCommit,
        moveCommit,
        renamePairs: [{ from: '../src/a.ts', to: validPair.to }],
      },
      {
        baseCommit,
        moveCommit,
        renamePairs: [{ from: validPair.from, to: '.git/config' }],
      },
      {
        baseCommit,
        moveCommit,
        renamePairs: [{ from: 'src/*.ts', to: validPair.to }],
      },
    ];

    for (const invalid of invalidRequests) {
      assert.throws(
        () =>
          verifyMechanicalMovePhase({
            repositoryRoot: repository,
            ...invalid,
          }),
        (error) => isWorkflowError(error, 'AUTHORITY_REMAP_INVALID'),
        JSON.stringify(invalid),
      );
    }

    write(repository, 'later.txt', 'later\n');
    commitAll(repository, 'Advance beyond move commit');
    assert.throws(
      () =>
        verifyMechanicalMovePhase({
          repositoryRoot: repository,
          baseCommit,
          moveCommit: head(repository),
          renamePairs: [validPair],
        }),
      (error) => isWorkflowError(error, 'AUTHORITY_REMAP_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function write(
  repository: string,
  relativePath: string,
  content: string,
): void {
  const target = path.join(repository, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function move(repository: string, from: string, to: string): void {
  fs.mkdirSync(path.dirname(path.join(repository, to)), { recursive: true });
  git(repository, ['mv', from, to]);
}

function commitAll(repository: string, message: string): void {
  git(repository, ['add', '-A']);
  git(repository, ['commit', '-m', message]);
}

function updatePathRoles(
  repository: string,
  mutate: (roles: Record<string, string[]>) => void,
): void {
  const registryPath = path.join(repository, 'workflow/path-roles.json');
  const value = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as {
    roles: Record<string, string[]>;
  };
  mutate(value.roles);
  fs.writeFileSync(registryPath, `${JSON.stringify(value, null, 2)}\n`);
}

function updateChecks(
  repository: string,
  mutate: (
    checks: Record<string, { command: string[]; destructiveDatabase: boolean }>,
  ) => void,
): void {
  const checksPath = path.join(repository, 'workflow/checks.json');
  const value = JSON.parse(fs.readFileSync(checksPath, 'utf8')) as {
    checks: Record<string, { command: string[]; destructiveDatabase: boolean }>;
  };
  mutate(value.checks);
  fs.writeFileSync(checksPath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeGuard(
  repository: string,
  relativePath: string,
  changeId: string,
  allowedPath: string,
): void {
  write(
    repository,
    relativePath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        changeId,
        tasks: {
          '1.1': {
            allowedPaths: [allowedPath],
            requiredChecks: ['fixture'],
          },
        },
      },
      null,
      2,
    )}\n`,
  );
}

type MaintainerPolicySource = {
  bootstrapEligiblePaths: string[];
  sealedImmutablePaths: string[];
  [key: string]: unknown;
};

function writeMaintainerPolicy(
  repository: string,
  mutate: (policy: MaintainerPolicySource) => void,
): void {
  const policy = JSON.parse(
    fs.readFileSync(
      path.join(sourceRepositoryRoot, 'workflow/maintainer-policy.json'),
      'utf8',
    ),
  ) as MaintainerPolicySource;
  mutate(policy);
  policy.bootstrapEligiblePaths.sort();
  policy.sealedImmutablePaths.sort();
  write(
    repository,
    'workflow/maintainer-policy.json',
    `${JSON.stringify(policy, null, 2)}\n`,
  );
}

function writeMaintainerProfiles(
  repository: string,
  options: {
    implementationPaths: string[];
    evidencePaths?: string[];
    policyPaths?: string[];
    verificationInfrastructurePaths?: string[];
    forbiddenPaths?: string[];
  },
): void {
  const profile = {
    id: 'remap-profile',
    version: 1,
    authorityClass: 'root-one-shot',
    implementationPaths: [...options.implementationPaths].sort(),
    evidencePaths: [...(options.evidencePaths ?? [])].sort(),
    policyPaths: [
      ...(options.policyPaths ?? [
        'workflow/maintainer-policy.json',
        'workflow/maintainer-profiles.json',
      ]),
    ].sort(),
    verificationInfrastructurePaths: [
      ...(options.verificationInfrastructurePaths ?? ['workflow/checks.json']),
    ].sort(),
    forbiddenPaths: [...(options.forbiddenPaths ?? [])].sort(),
    constraints: {
      evidenceOnlyGrantForbidden: true,
      samePackageRequired: true,
      evidenceAdditionsAllowed: true,
      maximumFiles: 100,
    },
    requiredChecks: ['fixture'],
    checkDependencies: {
      fixture: ['source-tree'],
    },
  };
  parseCapabilityProfile(profile);
  write(
    repository,
    'workflow/maintainer-profiles.json',
    `${JSON.stringify(
      {
        schemaVersion: 1,
        profiles: { 'remap-profile': profile },
      },
      null,
      2,
    )}\n`,
  );
}

function removeFixtureActiveGuard(repository: string): void {
  fs.rmSync(path.join(repository, 'openspec/changes/demo-change/guard.json'));
}

function head(repository: string): string {
  return git(repository, ['rev-parse', 'HEAD']).trim();
}
