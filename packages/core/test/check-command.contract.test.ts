import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseCheckCommand,
  parseChecksConfigSource,
} from '../src/check-command.ts';

test('core parses the landed node and package-bin check command grammar', () => {
  assert.deepEqual(parseCheckCommand(['node', 'scripts/check.mjs']), {
    runner: 'node',
    args: ['scripts/check.mjs'],
    entrypoints: ['scripts/check.mjs'],
  });
  assert.deepEqual(
    parseCheckCommand([
      'node',
      '--experimental-strip-types',
      '--test',
      '--test-concurrency=4',
      'test/one.test.ts',
      'test/two.test.ts',
    ]),
    {
      runner: 'node',
      args: [
        '--experimental-strip-types',
        '--test',
        '--test-concurrency=4',
        'test/one.test.ts',
        'test/two.test.ts',
      ],
      entrypoints: ['test/one.test.ts', 'test/two.test.ts'],
    },
  );
  assert.deepEqual(
    parseCheckCommand([
      'node-package-bin',
      'packages/core',
      '@scope/tool',
      'tool',
      '--check',
    ]),
    {
      runner: 'node-package-bin',
      workspace: 'packages/core',
      packageName: '@scope/tool',
      binName: 'tool',
      args: ['--check'],
    },
  );
});

test('core check command grammar rejects unsafe paths and executable shapes', () => {
  for (const command of [
    [],
    ['node', '--eval'],
    ['node', '../outside.mjs'],
    ['node', 'scripts/**'],
    ['node', ' scripts/check.mjs'],
    ['node-package-bin', 'src/**', 'fixture-tool', 'fixture-tool'],
    ['node-package-bin', '.', '..', 'fixture-tool'],
    ['node-package-bin', '.', 'fixture-tool', '.'],
  ]) {
    assert.equal(parseCheckCommand(command), undefined);
  }
});

test('core parses the exact landed check registry value contract', () => {
  const valid = {
    schemaVersion: 1,
    checks: {
      'core-contract': {
        command: ['node', 'scripts/check.mjs'],
        destructiveDatabase: false,
      },
    },
  };
  assert.deepEqual(parseChecksConfigSource(valid), { ok: true, value: valid });
  assert.deepEqual(parseChecksConfigSource({ schemaVersion: 2, checks: {} }), {
    ok: false,
    reason: 'invalid-registry',
    checkId: null,
  });
  assert.deepEqual(
    parseChecksConfigSource({
      schemaVersion: 1,
      checks: {
        BAD_ID: {
          command: ['node', 'scripts/check.mjs'],
          destructiveDatabase: false,
        },
      },
    }),
    { ok: false, reason: 'invalid-definition', checkId: 'BAD_ID' },
  );
});
