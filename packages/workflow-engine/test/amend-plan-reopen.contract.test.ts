import assert from 'node:assert/strict';
import test from 'node:test';

import { assertTaskHistory } from '../src/entrypoints/ci/ci-task-state.ts';
import {
  amendmentLeftWorkMarkedDone,
  assertPlanningTaskHistory,
} from '../src/adapters/planning/openspec/documents/planning-contract.ts';

const DONE = [
  { id: '1.1', completed: true },
  { id: '1.2', completed: true },
];
const REOPENED = [
  { id: '1.1', completed: false },
  { id: '1.2', completed: false },
];

test('an ordinary plan may not send completed work back', () => {
  // This is the invariant that made a post-execution correction impossible and
  // is exactly why the amendment verb had to exist.
  assert.throws(
    () => assertPlanningTaskHistory(DONE as never, REOPENED as never),
    (error: unknown) =>
      (error as { code?: string }).code === 'PLANNING_TASK_STATE_INVALID',
  );
});

test('an authorized amendment may reopen the work it invalidated', () => {
  assert.deepEqual(
    assertPlanningTaskHistory(DONE as never, REOPENED as never, {
      reopenAuthorized: true,
    }),
    ['1.1', '1.2'],
  );
});

test('reopening a chosen subset is refused even when authorized', () => {
  // A partial reopen claims the rest of the completed work is unaffected by
  // the correction, and nothing here can establish that. Redoing everything is
  // the answer that does not require the claim.
  assert.throws(
    () =>
      assertPlanningTaskHistory(
        DONE as never,
        [
          { id: '1.1', completed: false },
          { id: '1.2', completed: true },
        ] as never,
        { reopenAuthorized: true },
      ),
    (error: unknown) =>
      (error as { code?: string }).code === 'AMENDMENT_PARTIAL_REOPEN',
  );
});

test('no authorization lets a plan drop a completed task', () => {
  // Dropping it loses the record that the work was ever done.
  assert.throws(
    () =>
      assertPlanningTaskHistory(
        DONE as never,
        [{ id: '1.1', completed: false }] as never,
        { reopenAuthorized: true },
      ),
    (error: unknown) =>
      (error as { code?: string }).code === 'PLANNING_TASK_STATE_INVALID',
  );
});

test('no authorization lets a plan mark work done', () => {
  // Only the task transition may complete a task; a plan that could would let
  // an author sign off their own execution.
  assert.throws(
    () =>
      assertPlanningTaskHistory(
        [{ id: '1.1', completed: false }] as never,
        [{ id: '1.1', completed: true }] as never,
        { reopenAuthorized: true },
      ),
    (error: unknown) =>
      (error as { code?: string }).code === 'PLANNING_TASK_STATE_INVALID',
  );
});

test('an amendment that changed no task state reopened nothing', () => {
  assert.deepEqual(
    assertPlanningTaskHistory(DONE as never, DONE as never, {
      reopenAuthorized: true,
    }),
    [],
  );
});

test('CI refuses a reopen no commit authorized', () => {
  // The second gate: even with the planning rule satisfied, an ordinary commit
  // may not send completed work back.
  assert.throws(
    () => assertTaskHistory('demo-change', DONE as never, REOPENED as never),
    (error: unknown) =>
      (error as { code?: string }).code === 'CI_TASK_REOPENED',
  );
});

test('CI accepts the reopen the amendment authorized in its own block', () => {
  assert.doesNotThrow(() =>
    assertTaskHistory('demo-change', DONE as never, REOPENED as never, {
      reopenAuthorized: true,
    }),
  );
});

test('CI refuses a partial reopen for the same reason the plan does', () => {
  assert.throws(
    () =>
      assertTaskHistory(
        'demo-change',
        DONE as never,
        [
          { id: '1.1', completed: false },
          { id: '1.2', completed: true },
        ] as never,
        { reopenAuthorized: true },
      ),
    (error: unknown) =>
      (error as { code?: string }).code === 'CI_TASK_PARTIAL_REOPEN',
  );
});

test('a change with nothing completed may declare the impact conservatively', () => {
  // The edge both gates have to agree on. One condition, consulted by the
  // transition and by CI replay, so the engine cannot mint a commit its own
  // replay rejects — the divergence class this design exists to prevent.
  const nothingDone = [
    { id: '1.1', completed: false },
    { id: '1.2', completed: false },
  ];
  assert.equal(
    amendmentLeftWorkMarkedDone({
      reopenAuthorized: true,
      reopenedTasks: [],
      beforeTasks: nothingDone as never,
    }),
    false,
    'nothing was left marked done, because nothing was done',
  );
  assert.deepEqual(
    assertPlanningTaskHistory(nothingDone as never, nothingDone as never, {
      reopenAuthorized: true,
    }),
    [],
  );
  assert.doesNotThrow(() =>
    assertTaskHistory(
      'demo-change',
      nothingDone as never,
      nothingDone as never,
      {
        reopenAuthorized: true,
      },
    ),
  );
});

test('declaring the work invalid while leaving it marked done is the one refusal', () => {
  assert.equal(
    amendmentLeftWorkMarkedDone({
      reopenAuthorized: true,
      reopenedTasks: [],
      beforeTasks: DONE as never,
    }),
    true,
  );
  // An amendment that did reopen its work, and any amendment that never
  // claimed the work was invalid, both pass.
  assert.equal(
    amendmentLeftWorkMarkedDone({
      reopenAuthorized: true,
      reopenedTasks: ['1.1'],
      beforeTasks: DONE as never,
    }),
    false,
  );
  assert.equal(
    amendmentLeftWorkMarkedDone({
      reopenAuthorized: false,
      reopenedTasks: [],
      beforeTasks: DONE as never,
    }),
    false,
  );
});
