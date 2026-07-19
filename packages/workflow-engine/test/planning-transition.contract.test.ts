import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertPlanningPaths,
  assertPlanningTaskHistory,
} from '../src/planning-transition.ts';
import { isWorkflowError } from './fixture.ts';

test('planning paths accept only the exact named OpenSpec planning grammar', () => {
  assert.doesNotThrow(() =>
    assertPlanningPaths('openspec/changes', 'demo-change', [
      'openspec/changes/demo-change/.openspec.yaml',
      'openspec/changes/demo-change/design.md',
      'openspec/changes/demo-change/guard.json',
      'openspec/changes/demo-change/proposal.md',
      'openspec/changes/demo-change/specs/demo/spec.md',
      'openspec/changes/demo-change/tasks.md',
    ]),
  );

  for (const invalidPath of [
    'src/feature.ts',
    'openspec/specs/demo/spec.md',
    'openspec/changes/archive/2026-07-15-demo-change/tasks.md',
    'openspec/changes/other-change/tasks.md',
    'openspec/changes/demo-change/README.md',
    'openspec/changes/demo-change/specs/demo/notes.md',
    'openspec/changes/demo-change/specs/spec.md',
  ]) {
    assert.throws(
      () =>
        assertPlanningPaths('openspec/changes', 'demo-change', [invalidPath]),
      (error) => isWorkflowError(error, 'PLANNING_PATHS_INVALID'),
      invalidPath,
    );
  }
});

test('planning paths reject the reserved OpenSpec archive container as a change', () => {
  assert.throws(
    () =>
      assertPlanningPaths('openspec/changes', 'archive', [
        'openspec/changes/archive/proposal.md',
      ]),
    (error) => isWorkflowError(error, 'PLANNING_CHANGE_ID_RESERVED'),
  );
});

test('planning introductions require every task to be unchecked', () => {
  assert.doesNotThrow(() =>
    assertPlanningTaskHistory(undefined, [
      { id: '1.1', completed: false, title: 'First task' },
      { id: '1.2', completed: false, title: 'Second task' },
    ]),
  );
  assert.throws(
    () =>
      assertPlanningTaskHistory(undefined, [
        { id: '1.1', completed: true, title: 'Already complete' },
      ]),
    (error) => isWorkflowError(error, 'PLANNING_TASK_STATE_INVALID'),
  );
});

test('planning revisions preserve shared state and add only unchecked tasks', () => {
  const before = [
    { id: '1.1', completed: true, title: 'Completed task' },
    { id: '1.2', completed: false, title: 'Planned task' },
  ];
  assert.doesNotThrow(() =>
    assertPlanningTaskHistory(before, [
      { ...before[0], title: 'Retitled completed task' },
      { id: '1.3', completed: false, title: 'New task' },
    ]),
  );

  for (const after of [
    [{ ...before[0], completed: false }, before[1]],
    [before[1]],
    [...before, { id: '1.3', completed: true, title: 'New but checked' }],
  ]) {
    assert.throws(
      () => assertPlanningTaskHistory(before, after),
      (error) => isWorkflowError(error, 'PLANNING_TASK_STATE_INVALID'),
    );
  }
});

test('planning paths accept only in-tree deletions of non-canonical files', () => {
  assert.doesNotThrow(() =>
    assertPlanningPaths(
      'openspec/changes',
      'demo-change',
      [
        'openspec/changes/demo-change/design.md',
        'openspec/changes/demo-change/requirement-audit.md',
      ],
      ['openspec/changes/demo-change/requirement-audit.md'],
    ),
  );
  assert.throws(
    () =>
      assertPlanningPaths('openspec/changes', 'demo-change', [
        'openspec/changes/demo-change/requirement-audit.md',
      ]),
    (error) => isWorkflowError(error, 'PLANNING_PATHS_INVALID'),
  );
  assert.throws(
    () =>
      assertPlanningPaths(
        'openspec/changes',
        'demo-change',
        ['openspec/changes/other-change/noise.md'],
        ['openspec/changes/other-change/noise.md'],
      ),
    (error) => isWorkflowError(error, 'PLANNING_PATHS_INVALID'),
  );
});
