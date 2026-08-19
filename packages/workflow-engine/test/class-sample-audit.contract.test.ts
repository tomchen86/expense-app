import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classSampleSize,
  planClassSampleAudits,
  resolveSampleAudits,
} from '../src/modules/investigation/domain/class-sample-audit.ts';
import { isWorkflowError } from './fixture.ts';

const SEED = 'a'.repeat(64);

function members(count: number, prefix = 'g'): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}-${index}`);
}

test('a sample is at least three, or a tenth, whichever is larger', () => {
  assert.equal(classSampleSize(1), 1);
  assert.equal(classSampleSize(3), 3);
  assert.equal(classSampleSize(10), 3);
  assert.equal(classSampleSize(31), 4);
  assert.equal(classSampleSize(100), 10);
});

test('the sample is reproducible from the sealed seed', () => {
  const first = planClassSampleAudits(SEED, [
    { classId: 'c1', members: members(40) },
  ]);
  const second = planClassSampleAudits(SEED, [
    { classId: 'c1', members: members(40) },
  ]);
  assert.deepEqual(second, first);
  assert.equal(first[0].sampled.length, 4);
});

test('a different seed selects a different sample', () => {
  const withA = planClassSampleAudits(SEED, [
    { classId: 'c1', members: members(40) },
  ]);
  const withB = planClassSampleAudits('b'.repeat(64), [
    { classId: 'c1', members: members(40) },
  ]);
  assert.notDeepEqual(withB[0].sampled, withA[0].sampled);
});

test('the author cannot influence selection by reordering members', () => {
  const forward = planClassSampleAudits(SEED, [
    { classId: 'c1', members: members(40) },
  ]);
  const reversed = planClassSampleAudits(SEED, [
    { classId: 'c1', members: [...members(40)].reverse() },
  ]);
  assert.deepEqual(reversed[0].sampled, forward[0].sampled);
});

test('a plan cannot commit while an audit is unresolved', () => {
  const plan = planClassSampleAudits(SEED, [
    { classId: 'c1', members: members(40) },
  ]);
  assert.throws(
    () => resolveSampleAudits(plan, []),
    (error) => isWorkflowError(error, 'CLASS_SAMPLE_AUDIT_INCOMPLETE'),
  );
  const partial = plan[0].sampled
    .slice(0, 2)
    .map((groupId) => ({ classId: 'c1', groupId, outcome: 'passed' as const }));
  assert.throws(
    () => resolveSampleAudits(plan, partial),
    (error) => isWorkflowError(error, 'CLASS_SAMPLE_AUDIT_INCOMPLETE'),
  );
});

test('every audit passing admits the class', () => {
  const plan = planClassSampleAudits(SEED, [
    { classId: 'c1', members: members(40) },
  ]);
  const outcome = resolveSampleAudits(
    plan,
    plan[0].sampled.map((groupId) => ({
      classId: 'c1',
      groupId,
      outcome: 'passed' as const,
    })),
  );
  assert.equal(outcome.classes[0].admitted, true);
  assert.deepEqual(outcome.expandIndividually, []);
});

test('one failed class doubles the sampling of the others', () => {
  const plan = planClassSampleAudits(SEED, [
    { classId: 'c1', members: members(40, 'a') },
    { classId: 'c2', members: members(40, 'b') },
    { classId: 'c3', members: members(40, 'c') },
  ]);
  const audits = plan.flatMap(({ classId, sampled }) =>
    sampled.map((groupId, index) => ({
      classId,
      groupId,
      outcome:
        classId === 'c1' && index === 0
          ? ('member-misclassified' as const)
          : ('passed' as const),
    })),
  );
  const outcome = resolveSampleAudits(plan, audits);
  assert.equal(
    outcome.classes.find(({ classId }) => classId === 'c1')?.admitted,
    false,
  );
  // The failure is evidence about the author's judgement, not only about one
  // class, so the remaining classes are re-sampled at twice the depth.
  const c2 = outcome.classes.find(({ classId }) => classId === 'c2');
  assert.equal(c2?.admitted, false);
  assert.equal(c2?.additionalSampleRequired, classSampleSize(40));
  assert.deepEqual(outcome.expandIndividually, ['c1']);
});

test('a second failure abandons class compression for the whole change', () => {
  const plan = planClassSampleAudits(SEED, [
    { classId: 'c1', members: members(40, 'a') },
    { classId: 'c2', members: members(40, 'b') },
    { classId: 'c3', members: members(40, 'c') },
  ]);
  const audits = plan.flatMap(({ classId, sampled }) =>
    sampled.map((groupId, index) => ({
      classId,
      groupId,
      outcome:
        index === 0 && (classId === 'c1' || classId === 'c2')
          ? ('rationale-wrong' as const)
          : ('passed' as const),
    })),
  );
  const outcome = resolveSampleAudits(plan, audits);
  assert.deepEqual(outcome.expandIndividually, ['c1', 'c2', 'c3']);
  assert.ok(outcome.classes.every(({ admitted }) => !admitted));
});

test('an audit for a group outside the sample is refused', () => {
  const plan = planClassSampleAudits(SEED, [
    { classId: 'c1', members: members(40) },
  ]);
  assert.throws(
    () =>
      resolveSampleAudits(plan, [
        ...plan[0].sampled.map((groupId) => ({
          classId: 'c1',
          groupId,
          outcome: 'passed' as const,
        })),
        { classId: 'c1', groupId: 'g-not-sampled', outcome: 'passed' as const },
      ]),
    (error) => isWorkflowError(error, 'CLASS_SAMPLE_AUDIT_INVALID'),
  );
});

test('a seed chosen after the classes were drawn is refused', () => {
  assert.throws(
    () =>
      planClassSampleAudits('short-seed', [
        { classId: 'c1', members: members(4) },
      ]),
    (error) => isWorkflowError(error, 'CLASS_SAMPLE_AUDIT_INVALID'),
  );
});
