import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  FixtureRuntimePathError,
  assertFixtureChangeId,
  assertFixturePolicyPathInsideRepository,
  fixtureInvestigationRuntimePaths,
} from '../src/fixture-runtime-paths.ts';

test('fixture runtime paths use a distinct root through the public core kernel', () => {
  const container = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'fixture-runtime-paths-'),
  );
  try {
    const common = path.join(container, 'git-common');
    fs.mkdirSync(common);
    const paths = fixtureInvestigationRuntimePaths(common);
    assert.equal(
      paths.root,
      path.join(
        fs.realpathSync(common),
        'fixture-runtime-v1',
        'investigations',
      ),
    );
    assert.equal(paths.sessions, path.join(paths.root, 'sessions'));
    assert.equal(paths.invocations, path.join(paths.root, 'invocations'));
  } finally {
    fs.rmSync(container, { recursive: true, force: true });
  }
});

test('fixture owns error presentation while core owns identifier and boundary facts', () => {
  assert.equal(assertFixtureChangeId('fixture-change'), 'fixture-change');
  assert.throws(
    () => assertFixtureChangeId('Fixture-change'),
    isFixtureError('FIXTURE_CHANGE_ID_INVALID'),
  );

  const container = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'fixture-path-boundary-'),
  );
  const repository = path.join(container, 'repository');
  const outside = path.join(container, 'outside');
  fs.mkdirSync(repository);
  fs.mkdirSync(outside);
  try {
    fs.symlinkSync(outside, path.join(repository, 'escape'));
    assert.throws(
      () =>
        assertFixturePolicyPathInsideRepository(repository, 'escape/file.ts'),
      isFixtureError('FIXTURE_PATH_ESCAPES_REPOSITORY'),
    );
  } finally {
    fs.rmSync(container, { recursive: true, force: true });
  }
});

function isFixtureError(code: string) {
  return (error: unknown): boolean =>
    error instanceof FixtureRuntimePathError && error.code === code;
}
