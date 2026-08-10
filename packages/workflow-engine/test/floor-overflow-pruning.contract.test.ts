import assert from 'node:assert/strict';
import test from 'node:test';

import {
  pruneFloorToLimit,
  type FloorCandidate,
} from '../src/floor-overflow-pruning.ts';
import { isWorkflowError } from './fixture.ts';

function candidates(...entries: Array<[string, FloorCandidate['kind']]>) {
  return entries.map(([value, kind]) => ({ value, kind }));
}

test('a floor within the limit is untouched', () => {
  const floor = candidates(
    ['resolveTimeout', 'symbol'],
    ['600_000', 'literal'],
  );
  const pruned = pruneFloorToLimit(floor, 8);
  assert.deepEqual(pruned.terms, floor);
  assert.deepEqual(pruned.dropped, []);
  assert.equal(pruned.escalated, false);
});

test('identifiers outrank literals, which outrank variants', () => {
  // An identifier is what a consumer writes; a literal is what they may have
  // inlined; a variant is a guess about formatting. Dropping in that order
  // loses the least recall per term surrendered.
  const pruned = pruneFloorToLimit(
    candidates(
      ['3600000', 'variant'],
      ['600_000', 'literal'],
      ['resolveTimeout', 'symbol'],
      ['MAX_LIMITS', 'symbol'],
    ),
    2,
  );
  assert.deepEqual(
    pruned.terms.map(({ value }) => value),
    ['MAX_LIMITS', 'resolveTimeout'],
  );
  assert.deepEqual(
    pruned.dropped.map(({ value }) => value),
    ['3600000', '600_000'],
  );
});

test('overflow escalates rather than silently narrowing the search', () => {
  const pruned = pruneFloorToLimit(
    candidates(['a', 'symbol'], ['b', 'symbol'], ['c', 'literal']),
    2,
  );
  assert.equal(pruned.escalated, true);
  // Every surrendered term is named, so the narrowing is reviewable rather
  // than invisible.
  assert.deepEqual(
    pruned.dropped.map(({ value }) => value),
    ['c'],
  );
});

test('a floor of identifiers alone still cannot exceed the limit silently', () => {
  const pruned = pruneFloorToLimit(
    candidates(['a', 'symbol'], ['b', 'symbol'], ['c', 'symbol']),
    2,
  );
  assert.equal(pruned.terms.length, 2);
  assert.equal(pruned.escalated, true);
  assert.deepEqual(
    pruned.dropped.map(({ value }) => value),
    ['c'],
  );
});

test('pruning is deterministic for the same floor', () => {
  const floor = candidates(
    ['zeta', 'symbol'],
    ['alpha', 'symbol'],
    ['mid', 'literal'],
  );
  const first = pruneFloorToLimit(floor, 2);
  assert.deepEqual(pruneFloorToLimit([...floor].reverse(), 2), first);
});

test('a limit that admits nothing is a configuration error, not a pruning', () => {
  assert.throws(
    () => pruneFloorToLimit(candidates(['a', 'symbol']), 0),
    (error) => isWorkflowError(error, 'FLOOR_PRUNING_INVALID'),
  );
});

test('an empty floor prunes to nothing without escalating', () => {
  const pruned = pruneFloorToLimit([], 4);
  assert.deepEqual(pruned.terms, []);
  assert.equal(pruned.escalated, false);
});
