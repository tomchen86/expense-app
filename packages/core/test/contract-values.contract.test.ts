import assert from 'node:assert/strict';
import test from 'node:test';

import { isRecord, isStringArray } from '../src/contract-values.ts';

test('core owns the neutral runtime value-shape predicates', () => {
  assert.equal(isRecord({ value: true }), true);
  assert.equal(isRecord(Object.create(null)), true);
  assert.equal(isRecord(null), false);
  assert.equal(isRecord([]), false);
  assert.equal(isStringArray([]), true);
  assert.equal(isStringArray(['one', 'two']), true);
  assert.equal(isStringArray(['one', 2]), false);
  assert.equal(isStringArray({ 0: 'one' }), false);
});
