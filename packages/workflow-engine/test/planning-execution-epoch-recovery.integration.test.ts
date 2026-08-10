import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { ensurePlanningExecutionEpochCompleteForArchive } from '../src/planning-execution-epoch.ts';
import { createFixtureRepository, git, isWorkflowError } from './fixture.ts';

const GENERATION = 'a'.repeat(64);
const AMENDS = 'b'.repeat(64);
const REVIEW = 'c'.repeat(64);

test('epoch recovery without any immutable report refuses with its own error', () => {
  // A fresh clone carries the committed amendment but none of the runtime
  // report store. Recovery must refuse through its named error, not crash on
  // the missing directory.
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    fs.writeFileSync(
      path.join(repository, 'src/epoch-recovery-target.ts'),
      'export const EpochRecoveryNeedle = true;\n',
    );
    git(repository, ['add', 'src/epoch-recovery-target.ts']);
    git(repository, [
      'commit',
      '-m',
      [
        'Amend plan for demo-change',
        '',
        'Change: demo-change',
        'Transition: amend-plan',
        `Planning-Generation: ${GENERATION}`,
        `Amends-Planning-Generation: ${AMENDS}`,
        'Execution-Impact: none',
        `Plan-Review: ${REVIEW}`,
      ].join('\n'),
    ]);
    const head = git(repository, ['rev-parse', 'HEAD']).trim();
    // The archive entry point has already initialized the private runtime
    // root; only the report store is absent, exactly as in a fresh clone.
    fs.mkdirSync(path.join(repository, '.git/workflow-engine'), {
      mode: 0o700,
    });
    assert.equal(
      fs.existsSync(
        path.join(repository, '.git/workflow-engine/planning-reports'),
      ),
      false,
    );
    assert.throws(
      () =>
        ensurePlanningExecutionEpochCompleteForArchive(repository, {
          changeId: 'demo-change',
          head,
          planningGeneration: GENERATION,
          taskEvidence: [
            {
              taskId: '1.1',
              source: 'managed-task-commit',
              commitHash: head,
            },
          ],
          now: new Date(),
        }),
      (error: unknown) =>
        isWorkflowError(error, 'PLANNING_EXECUTION_EPOCH_RECOVERY_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
