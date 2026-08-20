import assert from 'node:assert/strict';
import test from 'node:test';

import { fixtureSessionRuntimeLayoutPort } from '../src/fixture-session-runtime-layout.ts';

test('fixture adapter consumes the public session layout contract with distinct paths', () => {
  assert.equal(
    fixtureSessionRuntimeLayoutPort.contractVersion,
    'jigwright.session-runtime-layout-port.v1',
  );
  assert.deepEqual(
    fixtureSessionRuntimeLayoutPort.resolve({
      gitCommonDirectory: '/fixture/.git',
      runtimeDirectory: 'jig-runtime',
    }),
    {
      root: '/fixture/.git/jig-runtime/fixture-state',
      locks: '/fixture/.git/jig-runtime/fixture-state/mutex',
      operations: '/fixture/.git/jig-runtime/fixture-state/transitions',
      sessions: '/fixture/.git/jig-runtime/fixture-state/work-sessions',
      reports: '/fixture/.git/jig-runtime/fixture-state/evidence',
      taskRevisions: '/fixture/.git/jig-runtime/fixture-state/revisions',
    },
  );
});
