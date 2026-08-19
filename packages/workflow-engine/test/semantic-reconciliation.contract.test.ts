import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertImplementationReconciled,
  reconcileImplementation,
  type ActualMutation,
  type ChangedRange,
  type PlannedMutation,
} from '../src/modules/why-knowledge/semantic-reconciliation.ts';
import { isWorkflowError } from './fixture.ts';

const RANGE: ChangedRange = { path: 'src/a.ts', startLine: 10, endLine: 20 };
const OTHER: ChangedRange = { path: 'src/b.ts', startLine: 1, endLine: 4 };

const PLANNED: PlannedMutation[] = [
  {
    subjectId: 'alpha',
    intendedChange: 'Raise the ceiling.',
    invariantsToPreserve: ['Retry lineage is never rewritten.'],
  },
];

function actual(overrides: Partial<ActualMutation> = {}): ActualMutation {
  return {
    subjectId: 'alpha',
    disposition: 'existing-subject-changed',
    whatChanged: 'The ceiling moved.',
    whyChanged: 'The old one could not express the needed value.',
    preservedInvariants: ['Retry lineage is never rewritten.'],
    removedInvariants: [],
    ranges: [RANGE],
    ...overrides,
  };
}

test('a change that did what it said reconciles', () => {
  const verdict = reconcileImplementation(PLANNED, [actual()], [RANGE]);
  assert.equal(verdict.reconciled, true);
  assertImplementationReconciled(verdict);
});

test('a changed range nobody explained blocks completion', () => {
  // The alternative is evidence describing a different change than the one
  // being committed.
  const verdict = reconcileImplementation(PLANNED, [actual()], [RANGE, OTHER]);
  assert.deepEqual(verdict.unaccountedRanges, [OTHER]);
  assert.equal(verdict.reconciled, false);
  assert.throws(
    () => assertImplementationReconciled(verdict),
    (error) => isWorkflowError(error, 'SEMANTIC_MUTATION_UNACCOUNTED'),
  );
});

test('removing an invariant the plan promised to keep is the loudest failure', () => {
  const verdict = reconcileImplementation(
    PLANNED,
    [
      actual({
        preservedInvariants: [],
        removedInvariants: ['Retry lineage is never rewritten.'],
      }),
    ],
    [RANGE],
  );
  assert.deepEqual(verdict.brokenInvariants, [
    'alpha: Retry lineage is never rewritten.',
  ]);
  assert.throws(
    () => assertImplementationReconciled(verdict),
    (error) => isWorkflowError(error, 'SEMANTIC_INVARIANT_BROKEN'),
  );
});

test('touching something unplanned is surfaced without being forbidden', () => {
  const verdict = reconcileImplementation(
    PLANNED,
    [actual(), actual({ subjectId: 'beta', ranges: [OTHER] })],
    [RANGE, OTHER],
  );
  assert.deepEqual(verdict.unplannedSubjects, ['beta']);
  // Discovering more during implementation is normal; hiding it is not.
  assert.equal(verdict.reconciled, true);
});

test('an intent that was abandoned is reported', () => {
  const verdict = reconcileImplementation(
    [
      ...PLANNED,
      {
        subjectId: 'gamma',
        intendedChange: 'Also this.',
        invariantsToPreserve: [],
      },
    ],
    [actual()],
    [RANGE],
  );
  assert.deepEqual(verdict.abandonedIntents, ['gamma']);
});

test('generated and vendored ranges are explained, not exempted', () => {
  const verdict = reconcileImplementation(
    [],
    [
      actual({
        subjectId: 'generated.output',
        disposition: 'generated-output',
        ranges: [OTHER],
        preservedInvariants: [],
      }),
    ],
    [OTHER],
  );
  assert.equal(verdict.reconciled, true);
  assert.deepEqual(verdict.unaccountedRanges, []);
});
