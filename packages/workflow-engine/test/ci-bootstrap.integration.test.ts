import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { verifyPullRequest } from '../src/ci.ts';
import { createFixtureRepository, git, isWorkflowError } from './fixture.ts';

test('bootstrap compatibility commits match one exact semantic sequence', () => {
  const repository = createFixtureRepository();
  try {
    const sourceCommit = git(repository, ['rev-parse', 'HEAD']).trim();
    git(repository, ['checkout', '--orphan', 'ci-base']);
    fs.rmSync(path.join(repository, 'openspec/changes/demo-change'), {
      recursive: true,
      force: true,
    });
    git(repository, ['add', '-A']);
    git(repository, ['commit', '-m', 'Create CI base without change']);
    const base = git(repository, ['rev-parse', 'HEAD']).trim();
    git(repository, ['checkout', '-b', 'work/bootstrap-compatibility']);

    fs.writeFileSync(
      path.join(repository, 'workflow/ci-policy.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          bootstrapExceptions: [
            {
              changeId: 'demo-change',
              taskIds: ['1.1'],
              compatibilityCommits: [
                {
                  taskId: '1.1',
                  subject: 'Record compatibility evidence',
                  changedPaths: ['src/compatibility.ts'],
                },
              ],
              introductionPaths: [
                'openspec/changes/demo-change/proposal.md',
                'openspec/changes/demo-change/design.md',
                'openspec/changes/demo-change/tasks.md',
                'openspec/changes/demo-change/guard.json',
                'openspec/changes/demo-change/specs/demo/spec.md',
              ],
              allowedPaths: [
                'openspec/changes/demo-change/**',
                'src/**',
                'workflow/ci-policy.json',
              ],
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    git(repository, [
      'checkout',
      sourceCommit,
      '--',
      'openspec/changes/demo-change',
    ]);
    const tasksPath = path.join(
      repository,
      'openspec/changes/demo-change/tasks.md',
    );
    fs.writeFileSync(
      tasksPath,
      fs.readFileSync(tasksPath, 'utf8').replace('- [ ] 1.1', '- [x] 1.1'),
    );
    fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'Bootstrap demo change']);

    fs.writeFileSync(
      path.join(repository, 'src/compatibility.ts'),
      'export {};\n',
    );
    git(repository, ['add', '.']);
    git(repository, [
      'commit',
      '-m',
      'Record compatibility evidence',
      '-m',
      'Change: demo-change\nTask: 1.1',
    ]);
    const compatibleHead = git(repository, ['rev-parse', 'HEAD']).trim();
    assert.doesNotThrow(() =>
      verifyPullRequest(repository, base, compatibleHead),
    );

    fs.writeFileSync(path.join(repository, 'src/replay.ts'), 'export {};\n');
    git(repository, ['add', '.']);
    git(repository, [
      'commit',
      '-m',
      'Replay compatibility evidence',
      '-m',
      'Change: demo-change\nTask: 1.1',
    ]);
    const replayHead = git(repository, ['rev-parse', 'HEAD']).trim();
    assert.throws(
      () => verifyPullRequest(repository, base, replayHead),
      (error) => isWorkflowError(error, 'CI_TASK_TRANSITION_REQUIRED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
