import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  assertStoredEvidenceNode,
  canonicalEvidenceNodeEnvelope,
  createEvidenceNode,
  type EvidenceNodeInput,
} from '../src/evidence-node.ts';

class FixtureInvalidError extends Error {}

const invalid = () => new FixtureInvalidError('fixture evidence is invalid');
const INPUT: EvidenceNodeInput = {
  type: 'plan-review',
  nodeSchema: 'workflow.evidence-node.v1',
  evaluator: 'vector-evaluator.v1',
  policyDigest: '1'.repeat(64),
  exactInputDigests: { source: '2'.repeat(64) },
  semanticParentResultDigests: { prior: '3'.repeat(64) },
  provenanceParentNodeIds: { survey: '4'.repeat(64) },
  outputSchema: 'workflow.vector-output.v1',
  output: { decision: 'accepted', score: 1 },
  runtimeMetadata: { provider: 'codex', elapsedMs: 12 },
};

test('evidence node preserves the landed language-neutral envelope and digests', () => {
  const node = createEvidenceNode(INPUT, invalid);
  assert.equal(
    node.nodeId,
    'fa2215da5c1de37420ebfb03e28da4c1ef09ab5c5a4b5cb506a88682bb560837',
  );
  assert.equal(
    node.resultDigest,
    '119c7bef791b23ee835308cc1a1602305a2fbd16e736dc2f9343fcaf7ae8a3d1',
  );
  assert.equal(
    Buffer.from(canonicalEvidenceNodeEnvelope(node), 'utf8').toString('base64'),
    'eyJldmFsdWF0b3IiOiJ2ZWN0b3ItZXZhbHVhdG9yLnYxIiwiZXhhY3RJbnB1dERpZ2VzdHMiOnsic291cmNlIjoiMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMiJ9LCJub2RlSWQiOiJmYTIyMTVkYTVjMWRlMzc0MjBlYmZiMDNlMjhkYTRjMWVmMDlhYjVjNWE0YjVjYjUwNmE4ODY4MmJiNTYwODM3Iiwibm9kZVNjaGVtYSI6IndvcmtmbG93LmV2aWRlbmNlLW5vZGUudjEiLCJvdXRwdXQiOnsiZGVjaXNpb24iOiJhY2NlcHRlZCIsInNjb3JlIjoxfSwib3V0cHV0U2NoZW1hIjoid29ya2Zsb3cudmVjdG9yLW91dHB1dC52MSIsInBvbGljeURpZ2VzdCI6IjExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTEiLCJwcm92ZW5hbmNlUGFyZW50Tm9kZUlkcyI6eyJzdXJ2ZXkiOiI0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0In0sInJlc3VsdERpZ2VzdCI6IjExOWM3YmVmNzkxYjIzZWU4MzUzMDhjYzFhMTYwMjMwNWEyZmJkMTZlNzM2ZGMyZjkzNDNmY2FmN2FlOGEzZDEiLCJydW50aW1lTWV0YWRhdGEiOnsiZWxhcHNlZE1zIjoxMiwicHJvdmlkZXIiOiJjb2RleCJ9LCJzZW1hbnRpY1BhcmVudFJlc3VsdERpZ2VzdHMiOnsicHJpb3IiOiIzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzIn0sInR5cGUiOiJwbGFuLXJldmlldyJ9',
  );
  assert.deepEqual(
    assertStoredEvidenceNode(
      JSON.parse(canonicalEvidenceNodeEnvelope(node)) as unknown,
      invalid,
    ),
    node,
  );
});

test('evidence node snapshots caller data and delegates every invalid decision', () => {
  const mutable = structuredClone(INPUT);
  const node = createEvidenceNode(mutable, invalid);
  const before = canonicalEvidenceNodeEnvelope(node);
  mutable.exactInputDigests.source = '5'.repeat(64);
  (mutable.output as { score: number }).score = 99;
  mutable.runtimeMetadata.elapsedMs = 99;
  assert.equal(canonicalEvidenceNodeEnvelope(node), before);

  assert.throws(
    () => createEvidenceNode({ ...INPUT, policyDigest: 'invalid' }, invalid),
    FixtureInvalidError,
  );
  assert.throws(
    () =>
      assertStoredEvidenceNode(
        { ...node, resultDigest: 'f'.repeat(64) },
        invalid,
      ),
    FixtureInvalidError,
  );
});

test('evidence node is exported with only neutral core dependencies', () => {
  const manifest = JSON.parse(
    fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { exports?: Record<string, string> };
  assert.equal(manifest.exports?.['./evidence-node'], './src/evidence-node.ts');
  const source = fs.readFileSync(
    new URL('../src/evidence-node.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(
    source,
    /workflow-engine|workflowError|expense-app|openspec|investigation-v2/iu,
  );
  assert.deepEqual(
    [...source.matchAll(/from\s+['"]([^'"]+)['"]/gu)].map((match) => match[1]),
    ['node:crypto', './canonical-json.ts'],
  );
});
