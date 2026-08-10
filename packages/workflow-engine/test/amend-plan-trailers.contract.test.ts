import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ManagedTrailerSyntaxError,
  parseManagedTrailers,
} from '../src/managed-trailers.ts';

const GENERATION = 'a'.repeat(64);
const AMENDS = 'b'.repeat(64);
const REVIEW = 'c'.repeat(64);

function amendMessage(overrides: Partial<Record<string, string>> = {}): string {
  return [
    'Amend plan for demo-change',
    '',
    overrides.change ?? 'Change: demo-change',
    overrides.transition ?? 'Transition: amend-plan',
    overrides.generation ?? `Planning-Generation: ${GENERATION}`,
    overrides.amends ?? `Amends-Planning-Generation: ${AMENDS}`,
    overrides.impact ?? 'Execution-Impact: none',
    overrides.review ?? `Plan-Review: ${REVIEW}`,
  ].join('\n');
}

test('an amendment records which generation it replaces and what it costs', () => {
  // A plan revision after execution has to say more than that it happened, and
  // none of these facts can be recovered from the diff later.
  assert.deepEqual(parseManagedTrailers(amendMessage()), {
    kind: 'amend-plan',
    changeId: 'demo-change',
    transition: 'amend-plan',
    planningGeneration: GENERATION,
    amendsPlanningGeneration: AMENDS,
    executionImpact: 'none',
    planReview: REVIEW,
  });
});

test('an amendment may say the work already done must be redone', () => {
  const parsed = parseManagedTrailers(
    amendMessage({ impact: 'Execution-Impact: required' }),
  );
  assert.equal(
    parsed?.kind === 'amend-plan' ? parsed.executionImpact : null,
    'required',
  );
});

test('an unresolved execution impact is not a spelling the block accepts', () => {
  // Fail closed: an amendment that has not decided whether the work still
  // stands has not answered the question the transition exists to ask.
  assert.throws(
    () => parseManagedTrailers(amendMessage({ impact: 'Execution-Impact: unknown' })),
    ManagedTrailerSyntaxError,
  );
});

test('an amendment that claims to replace itself has recorded nothing', () => {
  assert.throws(
    () =>
      parseManagedTrailers(
        amendMessage({ amends: `Amends-Planning-Generation: ${GENERATION}` }),
      ),
    ManagedTrailerSyntaxError,
  );
});

test('a partial amendment block is refused rather than completed by assumption', () => {
  for (const missing of ['generation', 'amends', 'impact', 'review'] as const) {
    const lines = amendMessage().split('\n');
    const index = { generation: 4, amends: 5, impact: 6, review: 7 }[missing];
    lines.splice(index, 1);
    assert.throws(
      () => parseManagedTrailers(lines.join('\n')),
      ManagedTrailerSyntaxError,
      `a block missing its ${missing} line must not parse`,
    );
  }
});

test('an ordinary commit cannot fabricate an amendment by writing its lines', () => {
  // The names are reserved, so a hand-written line in the body is caught as a
  // non-canonical managed trailer rather than read as provenance.
  const smuggled = [
    'Ordinary work',
    '',
    `Planning-Generation: ${GENERATION}`,
    '',
    'Change: demo-change',
    'Transition: plan',
  ].join('\n');
  assert.throws(() => parseManagedTrailers(smuggled), ManagedTrailerSyntaxError);
});

test('a plan commit still parses exactly as it did', () => {
  assert.deepEqual(
    parseManagedTrailers(
      ['Plan demo-change', '', 'Change: demo-change', 'Transition: plan'].join(
        '\n',
      ),
    ),
    { kind: 'plan', changeId: 'demo-change', transition: 'plan' },
  );
});
