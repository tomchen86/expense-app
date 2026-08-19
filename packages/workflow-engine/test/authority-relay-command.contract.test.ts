import assert from 'node:assert/strict';
import test from 'node:test';

import {
  authorityAttestationRelayProjectionCommand,
  authorityAttestCommand,
  authorityTagPublishCommand,
} from '../src/authority-relay-command.ts';
import { WorkflowError } from '../src/foundation/errors/errors.ts';

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

test('authority attestation relay commands contain only literal commit bindings', () => {
  const original = 'a'.repeat(40);
  const main = 'b'.repeat(40);
  const originalBase = 'c'.repeat(40);
  const mainBase = 'd'.repeat(40);

  assert.equal(
    authorityAttestationRelayProjectionCommand(original),
    `pnpm workflow maintainer attestation-relay --original ${original} --json`,
  );
  const command = authorityAttestCommand({
    originalCommit: original,
    mainCommit: main,
    grantBasePairs: [{ originalBase, mainBase }],
  });
  assert.equal(
    command,
    `pnpm workflow maintainer attest --original ${original} --main ${main} --base ${originalBase}=${mainBase} --json`,
  );
  assert.equal(/[|<>]/.test(command), false);
  assert.equal(command.includes('$('), false);
  assert.equal(command.includes('<'), false);
});

test('authority attestation relay commands reject placeholders and malformed pairs', () => {
  const original = 'a'.repeat(40);
  const main = 'b'.repeat(40);
  for (const run of [
    () => authorityAttestationRelayProjectionCommand('<original>'),
    () =>
      authorityAttestCommand({
        originalCommit: original,
        mainCommit: main,
        grantBasePairs: [
          { originalBase: 'c'.repeat(40), mainBase: '$(git rev-parse HEAD)' },
        ],
      }),
  ]) {
    assert.throws(
      run,
      (error) =>
        error instanceof WorkflowError &&
        error.code === 'AUTHORITY_RELAY_COMMAND_INVALID',
    );
  }
});
