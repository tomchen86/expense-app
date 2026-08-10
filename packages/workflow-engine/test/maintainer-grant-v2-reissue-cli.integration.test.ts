import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createFixtureRepository } from './fixture.ts';

test('the production CLI routes retained-candidate reissue before legacy grant fallback', () => {
  const repository = createFixtureRepository();
  const cli = path.resolve(import.meta.dirname, '../src/cli.ts');
  try {
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        cli,
        'maintainer',
        'grant',
        'reissue-and-apply',
        '--grant',
        '11111111-1111-4111-8111-111111111111',
        '--reason',
        'Reissue the exact retained candidate after its prior grant expired.',
        '--json',
      ],
      { cwd: repository, encoding: 'utf8' },
    );

    assert.equal(result.status, 14, result.stderr);
    const output = JSON.parse(result.stderr) as {
      error: { code: string; message: string };
    };
    assert.equal(output.error.code, 'MAINTAINER_GRANT_STORE_UNSAFE');
    assert.match(output.error.message, /storage is malformed or unsafe/);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
