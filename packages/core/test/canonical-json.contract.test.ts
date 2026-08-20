import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CanonicalJsonError,
  canonicalJson,
  compareCanonicalStrings,
} from '../src/canonical-json.ts';

test('core canonical JSON preserves the landed deterministic byte contract', () => {
  assert.equal(
    canonicalJson({ z: [3, { b: true, a: null }], a: 'value' }),
    '{"a":"value","z":[3,{"a":null,"b":true}]}',
  );
  assert.deepEqual(['z', 'a', 'ä', 'A'].sort(compareCanonicalStrings), [
    'A',
    'a',
    'z',
    'ä',
  ]);
  assert.equal(
    canonicalJson(Object.assign(Object.create(null), { b: 2, a: 1 })),
    '{"a":1,"b":2}',
  );
});

test('core canonical JSON rejects values that cannot own signed bytes', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const sparse = new Array(2);
  sparse[1] = 'value';
  for (const value of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    undefined,
    1n,
    new Date('2026-08-20T00:00:00.000Z'),
    sparse,
    cyclic,
  ]) {
    assert.throws(
      () => canonicalJson(value),
      (error) => error instanceof CanonicalJsonError,
    );
  }
});
