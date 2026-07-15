import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  checkCodexPlanningAssets,
  generateCodexPlanningAssets,
  installCodexPlanningPrompts,
} from '../src/codex-planning-assets.ts';
import { sourceRepositoryRoot } from './fixture.ts';

function temporaryRepository(): string {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-codex-assets-'),
  );
  for (const file of [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
  ]) {
    fs.copyFileSync(
      path.join(sourceRepositoryRoot, file),
      path.join(repository, file),
    );
  }
  fs.symlinkSync(
    path.join(sourceRepositoryRoot, 'node_modules'),
    path.join(repository, 'node_modules'),
    'dir',
  );
  return repository;
}

const generatorOptions = {
  installationRepositoryRoot: sourceRepositoryRoot,
};

test('Codex planning generation is isolated and produces only reviewed assets', () => {
  const repository = temporaryRepository();
  const realHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-real-home-'));
  const sentinel = path.join(realHome, 'sentinel');
  fs.writeFileSync(sentinel, 'unchanged\n');
  try {
    const result = generateCodexPlanningAssets(repository, {
      ...generatorOptions,
      callerEnvironment: {
        ...process.env,
        HOME: realHome,
        CODEX_HOME: realHome,
      },
    });

    assert.deepEqual(result.assetPaths, [
      '.codex/skills/openspec-explore/SKILL.md',
      '.codex/skills/openspec-propose/SKILL.md',
      'workflow/codex-assets/prompts/opsx-explore.md',
      'workflow/codex-assets/prompts/opsx-propose.md',
    ]);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'unchanged\n');
    assert.equal(
      fs.readdirSync(realHome).join(','),
      'sentinel',
      'generation must not write to a caller Codex home',
    );
    assert.equal(
      checkCodexPlanningAssets(repository, generatorOptions).valid,
      true,
    );

    const combined = result.assetPaths
      .map((assetPath) =>
        fs.readFileSync(path.join(repository, assetPath), 'utf8'),
      )
      .join('\n');
    assert.doesNotMatch(combined, /Bash\(openspec:\*\)/);
    assert.doesNotMatch(
      combined,
      /(?:^|\s)openspec\s+(?:apply|sync|archive|store)\b/m,
    );
    assert.doesNotMatch(combined, /\/opsx:/);
    assert.doesNotMatch(combined, /(?:AskUserQuestion|TodoWrite) tool/);
    assert.match(combined, /pnpm exec openspec/);
    assert.match(combined, /pnpm workflow start/);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(realHome, { recursive: true, force: true });
  }
});

test('Codex planning asset check detects drift without rewriting files', () => {
  const repository = temporaryRepository();
  try {
    generateCodexPlanningAssets(repository, generatorOptions);
    const assetPath = path.join(
      repository,
      '.codex/skills/openspec-explore/SKILL.md',
    );
    fs.appendFileSync(assetPath, '\nopenspec archive demo\n');
    const drifted = fs.readFileSync(assetPath, 'utf8');

    assert.throws(() => checkCodexPlanningAssets(repository, generatorOptions));
    assert.equal(fs.readFileSync(assetPath, 'utf8'), drifted);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('planning prompt installer uses exact destinations and never overwrites', () => {
  const repository = temporaryRepository();
  const codexHome = fs.mkdtempSync(
    path.join(os.tmpdir(), 'codex-install-home-'),
  );
  try {
    generateCodexPlanningAssets(repository, generatorOptions);
    const installed = installCodexPlanningPrompts(repository, codexHome);
    const canonicalHome = fs.realpathSync(codexHome);
    assert.deepEqual(installed.installedPaths, [
      path.join(canonicalHome, 'prompts/opsx-explore.md'),
      path.join(canonicalHome, 'prompts/opsx-propose.md'),
    ]);

    const existingPath = installed.installedPaths[0]!;
    const existing = fs.readFileSync(existingPath, 'utf8');
    assert.throws(() => installCodexPlanningPrompts(repository, codexHome));
    assert.equal(fs.readFileSync(existingPath, 'utf8'), existing);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});
