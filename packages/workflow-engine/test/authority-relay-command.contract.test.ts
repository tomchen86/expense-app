import assert from 'node:assert/strict';
import test from 'node:test';

import { authorityTagPublishCommand } from '../src/authority-relay-command.ts';
import { WorkflowError } from '../src/errors.ts';

test('authority tag publication uses the human-custody SSH remote', () => {
  const command = authorityTagPublishCommand(
    'https://github.com/example/fixture.git',
    'refs/tags/workflow-grant/22222222-2222-4222-8222-222222222222',
  );

  assert.equal(
    command,
    'git push git@github.com:example/fixture.git refs/tags/workflow-grant/22222222-2222-4222-8222-222222222222:refs/tags/workflow-grant/22222222-2222-4222-8222-222222222222',
  );
  assert.equal(command.includes(' origin '), false);
  assert.equal(/[|<>]/.test(command), false);
  assert.equal(command.includes('$('), false);
});

test('authority tag publication rejects noncanonical origins and refs', () => {
  for (const [origin, tagRef] of [
    [
      'git@github.com:example/fixture.git',
      'refs/tags/workflow-grant/22222222-2222-4222-8222-222222222222',
    ],
    [
      'https://github.com/example/fixture.git --upload-pack=evil',
      'refs/tags/workflow-grant/22222222-2222-4222-8222-222222222222',
    ],
    [
      'https://github.com/example/fixture.git',
      'refs/tags/workflow-grant/$(touch-pwned)',
    ],
    [
      'https://github.com/example/fixture.git',
      'refs/tags/workflow-grant/../../main',
    ],
  ] as const) {
    assert.throws(
      () => authorityTagPublishCommand(origin, tagRef),
      (error) =>
        error instanceof WorkflowError &&
        error.code === 'AUTHORITY_RELAY_COMMAND_INVALID',
    );
  }
});
