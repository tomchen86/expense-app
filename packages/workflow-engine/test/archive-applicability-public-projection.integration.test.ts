import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { validateCiPlanningCommit } from '../src/ci-planning.ts';
import { commitPlanningTransition } from '../src/planning-transition.ts';
import {
  createFixtureRepository,
  git,
  isWorkflowError,
  writeReadyV2ExemptChange,
} from './fixture.ts';

test('plan applicability executes the pinned public OpenSpec archive projection', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    fs.appendFileSync(
      path.join(repository, 'openspec/changes/demo-change/design.md'),
      '\nPublic archive projection is required.\n',
    );
    writeReadyV2ExemptChange(repository);
    rejectPublicArchive(repository);

    assert.throws(
      () => commitPlanningTransition(repository, 'demo-change'),
      (error) => isWorkflowError(error, 'OPENSPEC_ARCHIVE_FAILED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('plan applicability preserves SHA-256 Git object identity', () => {
  const repository = createFixtureRepository({ objectFormat: 'sha256' });
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    fs.appendFileSync(
      path.join(repository, 'openspec/changes/demo-change/design.md'),
      '\nSHA-256 public archive projection is required.\n',
    );
    writeReadyV2ExemptChange(repository);
    rejectPublicArchive(repository);

    assert.throws(
      () => commitPlanningTransition(repository, 'demo-change'),
      (error) => isWorkflowError(error, 'OPENSPEC_ARCHIVE_FAILED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI replays applicability from the immutable planning commit through the public archive', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    fs.appendFileSync(
      path.join(repository, 'openspec/changes/demo-change/design.md'),
      '\nImmutable public archive replay is required.\n',
    );
    writeReadyV2ExemptChange(repository);
    const committed = commitPlanningTransition(repository, 'demo-change');
    rejectPublicArchive(repository);

    assert.throws(
      () =>
        validateCiPlanningCommit(
          repository,
          committed.commitHash,
          'demo-change',
        ),
      (error) => isWorkflowError(error, 'OPENSPEC_ARCHIVE_FAILED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('plan applicability rejects a public archive that rewrites a reviewed artifact', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    fs.appendFileSync(
      path.join(repository, 'openspec/changes/demo-change/design.md'),
      '\nReviewed archive content must remain exact.\n',
    );
    writeReadyV2ExemptChange(repository);
    rewriteArchivedDesign(repository);

    assert.throws(
      () => commitPlanningTransition(repository, 'demo-change'),
      (error) => isWorkflowError(error, 'ARCHIVE_TRANSFORMATION_TREE_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function rejectPublicArchive(repository: string): void {
  const executable = path.join(
    repository,
    'node_modules/@fission-ai/openspec/bin/openspec.js',
  );
  const source = fs.readFileSync(executable, 'utf8');
  const archiveBranch = "if (process.argv[2] === 'archive') {";
  assert.equal(source.includes(archiveBranch), true);
  fs.writeFileSync(
    executable,
    source.replace(
      archiveBranch,
      `${archiveBranch}\n  process.stderr.write('public archive projection invoked');\n  process.exit(23);\n}\n${archiveBranch}`,
    ),
  );
}

function rewriteArchivedDesign(repository: string): void {
  const executable = path.join(
    repository,
    'node_modules/@fission-ai/openspec/bin/openspec.js',
  );
  const source = fs.readFileSync(executable, 'utf8');
  const rename = '  fs.renameSync(changeRoot, archivePath);';
  assert.equal(source.includes(rename), true);
  fs.writeFileSync(
    executable,
    source.replace(
      rename,
      `${rename}\n  fs.appendFileSync(path.join(archivePath, 'design.md'), '\\nrewritten by public archive\\n');`,
    ),
  );
}
