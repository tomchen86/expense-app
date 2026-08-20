import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  SESSION_RUNTIME_LAYOUT_PORT_CONTRACT_VERSION_V1,
  defaultSessionRuntimeLayoutPort,
  type SessionRuntimeLayoutPortV1,
} from '../src/session-runtime-layout-port.ts';

test('session runtime layout port exposes paths without storage or transition authority', () => {
  const port: SessionRuntimeLayoutPortV1 = {
    contractVersion: SESSION_RUNTIME_LAYOUT_PORT_CONTRACT_VERSION_V1,
    resolve({ gitCommonDirectory, runtimeDirectory }) {
      const root = path.join(gitCommonDirectory, runtimeDirectory);
      return {
        root,
        locks: path.join(root, 'locks'),
        operations: path.join(root, 'operations'),
        sessions: path.join(root, 'sessions'),
        reports: path.join(root, 'reports'),
        taskRevisions: path.join(root, 'task-revisions'),
      };
    },
  };

  assert.equal(
    port.contractVersion,
    'jigwright.session-runtime-layout-port.v1',
  );
  assert.deepEqual(
    port.resolve({
      gitCommonDirectory: '/fixture/.git',
      runtimeDirectory: 'runtime',
    }),
    {
      root: '/fixture/.git/runtime',
      locks: '/fixture/.git/runtime/locks',
      operations: '/fixture/.git/runtime/operations',
      sessions: '/fixture/.git/runtime/sessions',
      reports: '/fixture/.git/runtime/reports',
      taskRevisions: '/fixture/.git/runtime/task-revisions',
    },
  );
});

test('default session layout preserves the embedded engine path projection exactly', () => {
  assert.deepEqual(
    defaultSessionRuntimeLayoutPort.resolve({
      gitCommonDirectory: '/repository/.git',
      runtimeDirectory: 'workflow-engine',
    }),
    {
      root: '/repository/.git/workflow-engine',
      locks: '/repository/.git/workflow-engine/locks',
      operations: '/repository/.git/workflow-engine/operations',
      sessions: '/repository/.git/workflow-engine/sessions',
      reports: '/repository/.git/workflow-engine/reports',
      taskRevisions: '/repository/.git/workflow-engine/task-revisions',
    },
  );
});

test('core session layout contract remains consumer-neutral and contains no store or reducer', () => {
  const source = fs.readFileSync(
    new URL('../src/session-runtime-layout-port.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /expense-app|openspec|provider|grant/i);
  assert.doesNotMatch(
    source,
    /node:(?:fs|child_process)|\b(?:readFileSync|writeFileSync|renameSync|spawnSync)\b|function\s+\w*(?:transition|reduc)/i,
  );
  assert.match(source, /without owning session state/);
});
