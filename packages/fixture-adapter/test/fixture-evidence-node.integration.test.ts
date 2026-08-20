import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createFixtureEvidenceRecord,
  FixtureEvidenceNodeError,
  readFixtureEvidenceRecord,
  renderFixtureEvidenceRecord,
} from '../src/fixture-evidence-node.ts';

test('fixture adapter produces and reads a distinct public-core evidence envelope', () => {
  const input = {
    sourceDigest: 'a'.repeat(64),
    output: { observed: ['second', 'first'] },
    runtimeMetadata: { fixtureRun: 'run-1' },
  };
  const node = createFixtureEvidenceRecord(input);

  assert.equal(node.type, 'fixture-observation');
  assert.equal(node.nodeSchema, 'jigwright.fixture-evidence-node.v1');
  assert.equal(node.evaluator, 'jigwright.fixture-evaluator.v1');
  assert.equal(node.outputSchema, 'jigwright.fixture-result.v1');
  assert.match(node.nodeId, /^[0-9a-f]{64}$/u);
  assert.match(node.resultDigest, /^[0-9a-f]{64}$/u);

  input.output.observed[0] = 'mutated';
  input.runtimeMetadata.fixtureRun = 'mutated';
  const envelope = renderFixtureEvidenceRecord(node);
  assert.deepEqual(readFixtureEvidenceRecord(envelope), node);
  assert.deepEqual(node.output, { observed: ['second', 'first'] });
  assert.deepEqual(node.runtimeMetadata, { fixtureRun: 'run-1' });
});

test('fixture adapter rejects tampered digests and foreign evidence labels', () => {
  const node = createFixtureEvidenceRecord({
    sourceDigest: 'a'.repeat(64),
    output: { observed: [] },
    runtimeMetadata: {},
  });
  for (const candidate of [
    { ...node, resultDigest: 'f'.repeat(64) },
    { ...node, nodeSchema: 'foreign.evidence-node.v1' },
  ]) {
    assert.throws(
      () => readFixtureEvidenceRecord(renderFixtureEvidenceRecord(candidate)),
      FixtureEvidenceNodeError,
    );
  }
});
