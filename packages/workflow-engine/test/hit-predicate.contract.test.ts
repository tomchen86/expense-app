import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HIT_PREDICATE_LIMITS,
  evaluateHitPredicate,
  parseHitPredicate,
} from '../src/hit-predicate.ts';
import { isWorkflowError } from './fixture.ts';

function windowFor(text: string, needle: string) {
  const byteOffset = text.indexOf(needle);
  return {
    window: {
      rawBase64: Buffer.from(text, 'utf8').toString('base64'),
      utf8: text,
      byteOffset: 0,
      byteLength: Buffer.byteLength(text, 'utf8'),
      truncated: false,
    },
    matchOffset: byteOffset,
    matchLength: Buffer.byteLength(needle, 'utf8'),
  };
}

const CALL_SITE = windowFor(
  '  const child = spawn(command, { timeoutMs: resolved.timeoutMs });',
  'timeoutMs',
);
const DEFINITION = windowFor(
  '  timeoutMs: 3_600_000, // the ceiling itself',
  'timeoutMs',
);

test('a literal predicate holds exactly when the window contains it', () => {
  const predicate = parseHitPredicate({ contains: 'spawn(' });
  assert.equal(evaluateHitPredicate(predicate, CALL_SITE), true);
  assert.equal(evaluateHitPredicate(predicate, DEFINITION), false);
});

test('a token predicate does not match a longer identifier', () => {
  const subject = windowFor('const timeoutMsCeiling = 1;', 'timeoutMs');
  assert.equal(
    evaluateHitPredicate(
      parseHitPredicate({ containsToken: 'timeoutMs' }),
      subject,
    ),
    false,
  );
  assert.equal(
    evaluateHitPredicate(
      parseHitPredicate({ containsToken: 'timeoutMsCeiling' }),
      subject,
    ),
    true,
  );
});

test('position distinguishes reading a value from declaring it', () => {
  // This is the distinction the worked example needs: a call site passes a
  // resolved value, a definition assigns a literal to the name.
  const reads = parseHitPredicate({
    all: [{ contains: 'spawn(' }, { afterMatchContains: '}' }],
  });
  assert.equal(evaluateHitPredicate(reads, CALL_SITE), true);
  assert.equal(evaluateHitPredicate(reads, DEFINITION), false);

  const declares = parseHitPredicate({ afterMatchContains: ': 3_600_000' });
  assert.equal(evaluateHitPredicate(declares, DEFINITION), true);
  assert.equal(evaluateHitPredicate(declares, CALL_SITE), false);
});

test('combinators compose without surprises', () => {
  assert.equal(
    evaluateHitPredicate(
      parseHitPredicate({
        any: [{ contains: 'nope' }, { contains: 'spawn(' }],
      }),
      CALL_SITE,
    ),
    true,
  );
  assert.equal(
    evaluateHitPredicate(
      parseHitPredicate({ not: { contains: 'spawn(' } }),
      CALL_SITE,
    ),
    false,
  );
  assert.equal(
    evaluateHitPredicate(parseHitPredicate({ all: [] }), CALL_SITE),
    true,
  );
  assert.equal(
    evaluateHitPredicate(parseHitPredicate({ any: [] }), CALL_SITE),
    false,
  );
});

test('a hit with no stored window satisfies nothing', () => {
  // Path-surface hits have nothing to quote, so they can never be shown to
  // belong to a class and must never be folded into one.
  assert.equal(
    evaluateHitPredicate(parseHitPredicate({ contains: 'anything' }), {
      window: null,
      matchOffset: 0,
      matchLength: 3,
    }),
    false,
  );
  assert.equal(
    evaluateHitPredicate(parseHitPredicate({ not: { contains: 'anything' } }), {
      window: null,
      matchOffset: 0,
      matchLength: 3,
    }),
    false,
  );
});

test('a truncated window cannot prove an absence', () => {
  // `not` over a window that dropped bytes would claim something is missing
  // from text nobody stored.
  const truncated = {
    ...CALL_SITE,
    window: { ...CALL_SITE.window, truncated: true },
  };
  assert.equal(
    evaluateHitPredicate(parseHitPredicate({ contains: 'spawn(' }), truncated),
    true,
  );
  assert.equal(
    evaluateHitPredicate(
      parseHitPredicate({ not: { contains: 'absent' } }),
      truncated,
    ),
    false,
  );
});

test('predicates are bounded by construction', () => {
  let nested: unknown = { contains: 'x' };
  for (let depth = 0; depth <= HIT_PREDICATE_LIMITS.maxDepth; depth += 1) {
    nested = { not: nested };
  }
  assert.throws(
    () => parseHitPredicate(nested),
    (error) => isWorkflowError(error, 'HIT_PREDICATE_INVALID'),
  );
  assert.throws(
    () =>
      parseHitPredicate({
        contains: 'x'.repeat(HIT_PREDICATE_LIMITS.maxLiteralBytes + 1),
      }),
    (error) => isWorkflowError(error, 'HIT_PREDICATE_INVALID'),
  );
  assert.throws(
    () =>
      parseHitPredicate({
        any: Array.from({ length: HIT_PREDICATE_LIMITS.maxNodes + 1 }, () => ({
          contains: 'x',
        })),
      }),
    (error) => isWorkflowError(error, 'HIT_PREDICATE_INVALID'),
  );
});

test('anything resembling a regular expression is refused', () => {
  // Author-supplied predicates enter the replay path as untrusted input; the
  // engine has no bounded-regex machinery and this is not the place to need it.
  for (const malformed of [
    { matches: '.*' },
    { contains: 'x', extra: 1 },
    { contains: 42 },
    { contains: '' },
    'contains',
    null,
    [],
  ]) {
    assert.throws(
      () => parseHitPredicate(malformed),
      (error) => isWorkflowError(error, 'HIT_PREDICATE_INVALID'),
      JSON.stringify(malformed),
    );
  }
});

test('evaluation is deterministic for the same stored evidence', () => {
  // The class artifact stores the authored form and the engine parses it on
  // every replay, so the property that matters is that the same authored form
  // and the same window always agree.
  const authored = {
    all: [{ containsToken: 'timeoutMs' }, { contains: 'spawn(' }],
  };
  const first = evaluateHitPredicate(parseHitPredicate(authored), CALL_SITE);
  assert.equal(first, true);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal(
      evaluateHitPredicate(parseHitPredicate(authored), CALL_SITE),
      first,
    );
  }
});
