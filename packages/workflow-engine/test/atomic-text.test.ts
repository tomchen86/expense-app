import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { replaceTextAtomic } from '../src/atomic-text.ts';

test('replacement without create authority does not create parent directories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-atomic-text-'));
  const target = path.join(root, 'missing', 'target.md');
  try {
    assert.throws(() => replaceTextAtomic(target, 'content\n'));
    assert.equal(fs.existsSync(path.dirname(target)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test(
  'task projection keeps its workflow error taxonomy for an unsafe target',
  { skip: process.platform === 'win32' },
  async () => {
    const { projectTasksCompleted } = await import('../src/task-projection.ts');
    const { WorkflowError } = await import('../src/errors.ts');
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'workflow-atomic-text-'),
    );
    const real = path.join(root, 'real.md');
    const link = path.join(root, 'tasks.md');
    fs.writeFileSync(real, '- [ ] 1.1 Demo task\n');
    fs.symlinkSync(real, link);
    try {
      assert.throws(
        () => projectTasksCompleted(link, ['1.1']),
        (error) =>
          error instanceof WorkflowError &&
          error.code === 'TASK_PROJECTION_INVALID',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
