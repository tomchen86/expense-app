import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { commitArchiveTransition } from '../src/archive-transition.ts';
import { verifyPullRequest } from '../src/ci.ts';
import {
  createFixtureRepository,
  git,
  isWorkflowError,
  runtimeRoot,
  sourceRepositoryRoot,
  syncOriginMain,
} from './fixture.ts';

test('CI replays an archive from Git without trusting local runtime evidence', () => {
  const fixture = archivedFixture();
  try {
    fs.rmSync(runtimeRoot(fixture.repository), {
      recursive: true,
      force: true,
    });

    const result = verifyPullRequest(
      fixture.repository,
      fixture.base,
      fixture.head,
    );

    assert.deepEqual(result.commits, [fixture.head]);
    assert.deepEqual(result.archivedChanges, ['demo-change']);
    assert.equal(result.runtimeReportsTrusted, false);
    assert.deepEqual(
      result.checks.map(({ checkId }) => checkId),
      ['fixture'],
    );
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('CI archive replay normalizes only the UTC date directory', () => {
  const fixture = archivedFixture();
  try {
    const originalPath = path.join(fixture.repository, fixture.archivePath);
    const crossDatePath = path.join(
      fixture.repository,
      'openspec/changes/archive/2099-12-31-demo-change',
    );
    fs.renameSync(originalPath, crossDatePath);
    git(fixture.repository, ['add', '-A']);
    git(fixture.repository, ['commit', '--amend', '--no-edit']);
    const head = git(fixture.repository, ['rev-parse', 'HEAD']).trim();

    const result = verifyPullRequest(fixture.repository, fixture.base, head);

    assert.deepEqual(result.archivedChanges, ['demo-change']);
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('CI rejects an archive commit whose diff mixes unrelated evidence', () => {
  const fixture = archivedFixture();
  try {
    fs.writeFileSync(path.join(fixture.repository, 'mixed.txt'), 'mixed\n');
    git(fixture.repository, ['add', '.']);
    git(fixture.repository, ['commit', '--amend', '--no-edit']);
    const head = git(fixture.repository, ['rev-parse', 'HEAD']).trim();

    assert.throws(
      () => verifyPullRequest(fixture.repository, fixture.base, head),
      (error) => isWorkflowError(error, 'CI_ARCHIVE_REPLAY_MISMATCH'),
    );
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('CI rejects an archive with silently changed promoted content', () => {
  const fixture = archivedFixture();
  try {
    fs.appendFileSync(
      path.join(fixture.repository, 'openspec/specs/demo/spec.md'),
      '\nUnverified mutation.\n',
    );
    git(fixture.repository, ['add', '.']);
    git(fixture.repository, ['commit', '--amend', '--no-edit']);
    const head = git(fixture.repository, ['rev-parse', 'HEAD']).trim();

    assert.throws(
      () => verifyPullRequest(fixture.repository, fixture.base, head),
      (error) => isWorkflowError(error, 'CI_ARCHIVE_REPLAY_MISMATCH'),
    );
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('CI rejects mixed task and archive trailer forms even when hooks are bypassed', () => {
  const fixture = archivedFixture();
  try {
    git(fixture.repository, [
      'commit',
      '--amend',
      '-m',
      'Archive demo-change',
      '-m',
      'Change: demo-change\nTask: 1.1\nTransition: archive',
    ]);
    const head = git(fixture.repository, ['rev-parse', 'HEAD']).trim();

    assert.throws(
      () => verifyPullRequest(fixture.repository, fixture.base, head),
      (error) => isWorkflowError(error, 'CI_INVALID_MANAGED_TRAILERS'),
    );
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('CI rejects pinned dependency drift before archive replay', () => {
  const fixture = archivedFixture();
  try {
    const manifestPath = path.join(fixture.repository, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.devDependencies['@fission-ai/openspec'] = '^1.6.0';
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const head = amendArchive(fixture.repository);

    assert.throws(
      () => verifyPullRequest(fixture.repository, fixture.base, head),
      (error) => isWorkflowError(error, 'OPENSPEC_INSTALLATION_INVALID'),
    );
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('CI rejects reviewed schema drift before archive replay', () => {
  const fixture = archivedFixture();
  try {
    fs.appendFileSync(
      path.join(fixture.repository, 'openspec/schemas/expense-app/schema.yaml'),
      '\n# drift\n',
    );
    const head = amendArchive(fixture.repository);

    assert.throws(
      () => verifyPullRequest(fixture.repository, fixture.base, head),
      (error) => isWorkflowError(error, 'OPENSPEC_SCHEMA_CONTRACT_INVALID'),
    );
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('CI rejects forbidden generated lifecycle authority when hooks are bypassed', () => {
  const fixture = archivedFixture();
  try {
    fs.cpSync(
      path.join(sourceRepositoryRoot, '.codex'),
      path.join(fixture.repository, '.codex'),
      { recursive: true },
    );
    fs.cpSync(
      path.join(sourceRepositoryRoot, 'workflow/codex-assets'),
      path.join(fixture.repository, 'workflow/codex-assets'),
      { recursive: true },
    );
    fs.appendFileSync(
      path.join(fixture.repository, '.codex/skills/openspec-explore/SKILL.md'),
      '\nopenspec archive demo-change\n',
    );
    const head = amendArchive(fixture.repository);

    assert.throws(
      () => verifyPullRequest(fixture.repository, fixture.base, head),
      (error) => isWorkflowError(error, 'CODEX_ASSET_FORBIDDEN_AUTHORITY'),
    );
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('CI archive replay exempts pre-epoch task completions', () => {
  const repository = createFixtureRepository();
  try {
    const deltaPath = path.join(
      repository,
      'openspec/changes/demo-change/specs/demo/spec.md',
    );
    fs.writeFileSync(deltaPath, addedDelta());
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'Configure archive fixture']);

    const tasksPath = path.join(
      repository,
      'openspec/changes/demo-change/tasks.md',
    );
    fs.writeFileSync(
      tasksPath,
      fs.readFileSync(tasksPath, 'utf8').replace('- [ ] 1.1', '- [x] 1.1'),
    );
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'Bootstrap completion']);
    fs.appendFileSync(
      path.join(repository, 'openspec/changes/demo-change/design.md'),
      '\nEpoch revision.\n',
    );
    git(repository, ['add', '.']);
    git(repository, [
      'commit',
      '-m',
      'Plan demo-change',
      '-m',
      'Change: demo-change\nTransition: plan',
    ]);
    const base = git(repository, ['rev-parse', 'HEAD']).trim();
    syncOriginMain(repository);
    git(repository, ['checkout', '-b', 'work/archive-demo']);
    const archived = commitArchiveTransition(repository, 'demo-change');

    const result = verifyPullRequest(repository, base, archived.commitHash);

    assert.deepEqual(result.archivedChanges, ['demo-change']);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function archivedFixture(): {
  repository: string;
  base: string;
  head: string;
  archivePath: string;
} {
  const repository = createFixtureRepository();
  const deltaPath = path.join(
    repository,
    'openspec/changes/demo-change/specs/demo/spec.md',
  );
  fs.writeFileSync(deltaPath, addedDelta());
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'Configure archive fixture']);

  const tasksPath = path.join(
    repository,
    'openspec/changes/demo-change/tasks.md',
  );
  fs.writeFileSync(
    tasksPath,
    fs.readFileSync(tasksPath, 'utf8').replace('- [ ] 1.1', '- [x] 1.1'),
  );
  git(repository, ['add', '.']);
  git(repository, [
    'commit',
    '-m',
    'Complete demo task',
    '-m',
    'Change: demo-change\nTask: 1.1',
  ]);
  const base = git(repository, ['rev-parse', 'HEAD']).trim();
  syncOriginMain(repository);
  git(repository, ['checkout', '-b', 'work/archive-demo']);
  const archived = commitArchiveTransition(repository, 'demo-change');
  return {
    repository,
    base,
    head: archived.commitHash,
    archivePath: archived.archivePath,
  };
}

function addedDelta(): string {
  return [
    '# Delta',
    '',
    '## ADDED Requirements',
    '',
    '### Requirement: Demo',
    'The system SHALL provide a demo.',
    '',
    '#### Scenario: Demo works',
    '',
    '- **WHEN** the demo runs',
    '- **THEN** it succeeds',
    '',
  ].join('\n');
}

function amendArchive(repository: string): string {
  git(repository, ['add', '-A']);
  git(repository, ['commit', '--amend', '--no-edit']);
  return git(repository, ['rev-parse', 'HEAD']).trim();
}
