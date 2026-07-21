import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { withArchiveEligibility } from '../src/archive-eligibility.ts';
import { createArchiveTransformation } from '../src/archive-transformation.ts';
import {
  createFixtureRepository,
  git,
  isWorkflowError,
  syncOriginMain,
} from './fixture.ts';

test('archive transformation returns an exact full-index patch without mutating the real worktree', () => {
  const repository = completedFixture();
  try {
    const before = realState(repository);
    const result = withArchiveEligibility(
      repository,
      'demo-change',
      (eligible) => createArchiveTransformation(eligible),
    );

    assert.deepEqual(realState(repository), before);
    assert.equal(result.changeId, 'demo-change');
    assert.match(result.archiveName, /^\d{4}-\d{2}-\d{2}-demo-change$/);
    assert.equal(
      result.archivePath,
      `openspec/changes/archive/${result.archiveName}`,
    );
    assert.deepEqual(result.baseSpecPaths, ['openspec/specs/demo/spec.md']);
    assert.ok(
      result.changedPaths.every(
        (changedPath) =>
          changedPath.startsWith('openspec/changes/demo-change/') ||
          changedPath.startsWith(`${result.archivePath}/`) ||
          result.baseSpecPaths.includes(changedPath),
      ),
    );
    assert.match(result.patch, /^diff --git /m);
    assert.match(result.patch, /^index [0-9a-f]{40}\.\.[0-9a-f]{40}/m);
    assert.match(result.patchDigest, /^[0-9a-f]{64}$/);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

for (const fault of [
  ['PARTIAL_FAILURE', 'OPENSPEC_ARCHIVE_FAILED'],
  ['ARCHIVE_ESCAPE', 'OPENSPEC_ARCHIVE_PAYLOAD_INVALID'],
  ['ARCHIVE_UNEXPECTED', 'ARCHIVE_TRANSFORMATION_PATHS_INVALID'],
] as const) {
  test(`archive transformation confines ${fault[0].toLowerCase()} faults`, () => {
    const repository = completedFixture(fault[0]);
    try {
      const before = realState(repository);
      assert.throws(
        () =>
          withArchiveEligibility(repository, 'demo-change', (eligible) =>
            createArchiveTransformation(eligible),
          ),
        (error) => isWorkflowError(error, fault[1]),
      );
      assert.deepEqual(realState(repository), before);
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });
}

function completedFixture(marker?: string): string {
  const repository = createFixtureRepository();
  if (marker) {
    fs.appendFileSync(
      path.join(repository, 'openspec/changes/demo-change/specs/demo/spec.md'),
      `\n${marker}\n`,
    );
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', `Configure ${marker} archive fault`]);
  }
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
  syncOriginMain(repository);
  git(repository, ['checkout', '-b', 'work/archive-demo']);
  return repository;
}

function realState(repository: string) {
  return {
    head: git(repository, ['rev-parse', 'HEAD']).trim(),
    index: git(repository, ['write-tree']).trim(),
    status: git(repository, ['status', '--porcelain=v2', '-z']),
    worktrees: git(repository, ['worktree', 'list', '--porcelain']),
  };
}
