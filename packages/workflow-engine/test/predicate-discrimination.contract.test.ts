import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DISCRIMINATION_THRESHOLD,
  assessPredicateDiscrimination,
} from '../src/modules/investigation/domain/predicate-discrimination.ts';
import { parseHitPredicate } from '../src/modules/investigation/domain/hit-predicate.ts';

function subject(text: string, needle = 'timeoutMs') {
  const matchOffset = Math.max(0, text.indexOf(needle));
  return {
    window: {
      rawBase64: Buffer.from(text, 'utf8').toString('base64'),
      utf8: text,
      byteOffset: 0,
      byteLength: Buffer.byteLength(text, 'utf8'),
      truncated: false,
    },
    matchOffset,
    matchLength: needle.length,
  };
}

const WINDOWLESS = { window: null, matchOffset: 0, matchLength: 9 };

const MEMBERS = [
  subject('  spawn(cmd, { timeoutMs: resolved.timeoutMs });'),
  subject('  spawn(other, { timeoutMs: policy.timeoutMs });'),
  subject('  return spawn(bin, { timeoutMs });'),
];

const CONTROLS = [
  subject('  timeoutMs: 3_600_000,'),
  subject('  assert.equal(limits.timeoutMs, 600_000);'),
  subject('  export const timeoutMs = read();'),
  subject('  // timeoutMs is the ceiling'),
  subject('  type Limits = { timeoutMs: number };'),
  subject('  schema.timeoutMs.max = 3_600_000;'),
  subject('  if (timeoutMs > max) throw error;'),
  subject('  const timeoutMs = fromPolicy();'),
  subject('  logger.info({ timeoutMs });'),
  subject('  delete draft.timeoutMs;'),
];

test('a predicate that separates members from the rest is admissible', () => {
  const verdict = assessPredicateDiscrimination(
    parseHitPredicate({ contains: 'spawn(' }),
    MEMBERS,
    CONTROLS,
  );
  assert.equal(verdict.admissible, true);
  assert.equal(verdict.membersMatched, MEMBERS.length);
  assert.equal(verdict.rejectionRate, 1);
});

test('a tautology is refused however true it is of the members', () => {
  // "the window mentions the term" is true of every hit the term produced, so
  // it says nothing about why these hits belong together.
  const verdict = assessPredicateDiscrimination(
    parseHitPredicate({ contains: 'timeoutMs' }),
    MEMBERS,
    CONTROLS,
  );
  assert.equal(verdict.membersMatched, MEMBERS.length);
  assert.equal(verdict.rejectionRate, 0);
  assert.equal(verdict.admissible, false);
  // Named for what it is: not merely weak, but saying nothing at all.
  assert.ok(
    verdict.reasons.some((reason) => reason.startsWith('vacuous-predicate:')),
    JSON.stringify(verdict.reasons),
  );
});

test('a member the predicate does not match refuses the class outright', () => {
  const verdict = assessPredicateDiscrimination(
    parseHitPredicate({ contains: 'spawn(cmd' }),
    MEMBERS,
    CONTROLS,
  );
  assert.equal(verdict.admissible, false);
  assert.ok(
    verdict.reasons.some((reason) => reason.includes('member')),
    JSON.stringify(verdict.reasons),
  );
});

test('windowless controls are excluded rather than counted as rejections', () => {
  // A hit with no window can never match anything, so counting it as a
  // rejection would let a tautology borrow discrimination it does not have.
  const verdict = assessPredicateDiscrimination(
    parseHitPredicate({ contains: 'timeoutMs' }),
    MEMBERS,
    [...CONTROLS, WINDOWLESS, WINDOWLESS, WINDOWLESS],
  );
  assert.equal(verdict.controlCount, CONTROLS.length);
  assert.equal(verdict.rejectionRate, 0);
  assert.equal(verdict.admissible, false);
});

test('a class with nothing to compare against cannot prove discrimination', () => {
  const verdict = assessPredicateDiscrimination(
    parseHitPredicate({ contains: 'spawn(' }),
    MEMBERS,
    [],
  );
  assert.equal(verdict.admissible, false);
  assert.ok(
    verdict.reasons.some((reason) => reason.includes('control')),
    JSON.stringify(verdict.reasons),
  );
});

test('an empty class is not a class', () => {
  const verdict = assessPredicateDiscrimination(
    parseHitPredicate({ contains: 'spawn(' }),
    [],
    CONTROLS,
  );
  assert.equal(verdict.admissible, false);
});

test('the threshold is inclusive and reported exactly', () => {
  // Nine of ten controls rejected is exactly the default bar.
  const leaky = [
    ...CONTROLS.slice(0, 9),
    subject('  spawn(x, { timeoutMs });'),
  ];
  const verdict = assessPredicateDiscrimination(
    parseHitPredicate({ contains: 'spawn(' }),
    MEMBERS,
    leaky,
  );
  assert.equal(verdict.controlCount, 10);
  assert.equal(verdict.controlRejected, 9);
  assert.equal(verdict.rejectionRate, 0.9);
  assert.equal(DISCRIMINATION_THRESHOLD, 0.9);
  assert.equal(verdict.admissible, true);
});

test('a stricter threshold may be required but a weaker one may not', () => {
  const leaky = [
    ...CONTROLS.slice(0, 9),
    subject('  spawn(x, { timeoutMs });'),
  ];
  assert.equal(
    assessPredicateDiscrimination(
      parseHitPredicate({ contains: 'spawn(' }),
      MEMBERS,
      leaky,
      { threshold: 0.95 },
    ).admissible,
    false,
  );
  assert.equal(
    assessPredicateDiscrimination(
      parseHitPredicate({ contains: 'timeoutMs' }),
      MEMBERS,
      CONTROLS,
      { threshold: 0 },
    ).admissible,
    false,
  );
});
