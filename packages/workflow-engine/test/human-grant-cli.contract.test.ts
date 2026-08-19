import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { GrantCoordinator } from '../src/modules/authority/grant-coordinator.ts';
import { dispatchHumanGrantCli } from '../src/human-grant-cli.ts';
import {
  executeHumanResolutionGrant,
  recoverHumanResolutionGrant,
} from '../src/investigation-session.ts';
import { isWorkflowError } from './fixture.ts';

test('human grant CLI requires an agent-proposed reason but cannot submit the human decision', async () => {
  const calls: string[] = [];
  const coordinator = {
    async requestGrant() {
      throw new Error('not used');
    },
    inspectChallenge(challengeId) {
      calls.push(`inspect:${challengeId}`);
      return { challengeId } as never;
    },
    async resolveChallenge(challengeId) {
      calls.push(`decide:${challengeId}`);
      return { challengeId } as never;
    },
    async recoverChallenge(challengeId) {
      calls.push(`recover:${challengeId}`);
      return { challengeId } as never;
    },
  } satisfies GrantCoordinator;
  const dependencies = {
    coordinator: () => coordinator,
    async requestInvestigation(
      _cwd: string,
      investigationId: string,
      proposedReason: string,
    ) {
      calls.push(`request:${investigationId}:${proposedReason}`);
      return { investigationId, proposedReason };
    },
    async requestInvestigationV3(
      _cwd: string,
      investigationId: string,
      proposedReason: string,
    ) {
      calls.push(`request-v3:${investigationId}:${proposedReason}`);
      return { investigationId, proposedReason };
    },
  };

  await dispatchHumanGrantCli(
    [
      'grant',
      'human',
      'request-investigation',
      'investigation-demo',
      '--reason',
      'Reviewer budget is exhausted; human resolution is required.',
    ],
    '/repo',
    dependencies,
  );
  await dispatchHumanGrantCli(
    [
      'grant',
      'human',
      'request-investigation-v3',
      'investigation-demo',
      '--reason',
      'The v3 blocker requires a bounded human continuation.',
    ],
    '/repo',
    dependencies,
  );
  await dispatchHumanGrantCli(
    ['grant', 'human', 'decide', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
    '/repo',
    dependencies,
  );
  assert.deepEqual(calls, [
    'request:investigation-demo:Reviewer budget is exhausted; human resolution is required.',
    'request-v3:investigation-demo:The v3 blocker requires a bounded human continuation.',
    'decide:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  ]);

  await assert.rejects(
    dispatchHumanGrantCli(['grant', 'human', 'install'], '/repo', dependencies),
    (error) => isWorkflowError(error, 'USAGE'),
  );

  await assert.rejects(
    dispatchHumanGrantCli(
      ['grant', 'human', 'request-investigation', 'investigation-demo'],
      '/repo',
      dependencies,
    ),
    (error) => isWorkflowError(error, 'USAGE'),
  );

  await assert.rejects(
    dispatchHumanGrantCli(
      [
        'grant',
        'human',
        'decide',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        '--choice',
        'investigation.abort.v1',
        '--reason',
        'agent-supplied',
      ],
      '/repo',
      dependencies,
    ),
    (error) => isWorkflowError(error, 'USAGE'),
  );
  assert.equal(calls.length, 3);
});

test('legacy human-resolution apply and recovery cannot start a live transition', () => {
  assert.throws(
    () =>
      executeHumanResolutionGrant(
        '/path/that/must/not/be-read',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      ),
    (error) =>
      isWorkflowError(error, 'LEGACY_GRANT_V1_LIVE_TRANSITION_DISABLED'),
  );

  const cli = path.resolve(import.meta.dirname, '../src/cli.ts');
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      cli,
      'human-resolution-apply',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '--json',
    ],
    { cwd: os.tmpdir(), encoding: 'utf8' },
  );
  assert.equal(result.status, 10);
  assert.equal(
    (JSON.parse(result.stderr) as { error: { code: string } }).error.code,
    'LEGACY_GRANT_V1_LIVE_TRANSITION_DISABLED',
  );

  assert.throws(
    () =>
      recoverHumanResolutionGrant(
        '/path/that/must/not/be-read',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      ),
    (error) =>
      isWorkflowError(error, 'LEGACY_GRANT_V1_LIVE_TRANSITION_DISABLED'),
  );

  const recovery = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      cli,
      'human-resolution-recover',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '--json',
    ],
    { cwd: os.tmpdir(), encoding: 'utf8' },
  );
  assert.equal(recovery.status, 10);
  assert.equal(
    (JSON.parse(recovery.stderr) as { error: { code: string } }).error.code,
    'LEGACY_GRANT_V1_LIVE_TRANSITION_DISABLED',
  );
});
