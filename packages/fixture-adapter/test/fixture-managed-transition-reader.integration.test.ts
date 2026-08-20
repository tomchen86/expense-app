import assert from 'node:assert/strict';
import test from 'node:test';

import { ManagedTrailerSyntaxError } from '@jigwright/core/managed-transition-trailers';

import { readFixtureManagedTransitionLog } from '../src/fixture-managed-transition-reader.ts';

test('fixture adapter reads its commit-log schema through the public trailer grammar', () => {
  const observations = readFixtureManagedTransitionLog([
    {
      kind: 'jigwright.fixture-commit.v1',
      fixtureCommitId: 'fixture-ordinary',
      message: 'Record ordinary fixture work\n',
    },
    {
      kind: 'jigwright.fixture-commit.v1',
      fixtureCommitId: 'fixture-plan',
      message: 'Plan demo-change\n\nChange: demo-change\nTransition: plan\n',
    },
    {
      kind: 'jigwright.fixture-commit.v1',
      fixtureCommitId: 'fixture-task',
      message: 'Complete task\n\nChange: demo-change\nTask: 1.2',
    },
  ]);

  assert.deepEqual(observations, [
    {
      kind: 'jigwright.fixture-managed-transition.v1',
      fixtureCommitId: 'fixture-plan',
      trailers: {
        kind: 'plan',
        changeId: 'demo-change',
        transition: 'plan',
      },
    },
    {
      kind: 'jigwright.fixture-managed-transition.v1',
      fixtureCommitId: 'fixture-task',
      trailers: {
        kind: 'task',
        changeId: 'demo-change',
        taskId: '1.2',
      },
    },
  ]);
  assert.ok(Object.isFrozen(observations));
  assert.ok(Object.isFrozen(observations[0]));
});

test('fixture adapter fails closed on a malformed reserved trailer attempt', () => {
  assert.throws(
    () =>
      readFixtureManagedTransitionLog([
        {
          kind: 'jigwright.fixture-commit.v1',
          fixtureCommitId: 'fixture-forgery',
          message: 'Forge\n\nchange: demo-change\nTransition: plan\n',
        },
      ]),
    ManagedTrailerSyntaxError,
  );
});
