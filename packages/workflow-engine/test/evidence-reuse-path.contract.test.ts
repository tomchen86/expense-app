import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { parseInvestigationArtifact } from '../src/contracts.ts';
import {
  createConvergenceRecord,
  createDescendantReuseProof,
} from '../src/evidence-convergence.ts';
import {
  currentParentEvidenceRef,
  descendantReuseProofEvidenceRef,
  projectConvergedEvidenceGraph,
} from '../src/evidence-reuse-path.ts';
import { createEvidenceNode } from '../src/evidence-node.ts';
import { WorkflowError } from '../src/foundation/errors/errors.ts';

test('tracked evidence reuse requires an exact current-parent and proof ref pair', () => {
  const oldParent = createEvidenceNode({
    type: 'fixture-parent',
    nodeSchema: 'fixture.parent.v1',
    evaluator: 'fixture.parent.v1',
    policyDigest: 'a'.repeat(64),
    exactInputDigests: { source: 'b'.repeat(64) },
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: 'fixture.parent-output.v1',
    output: { equivalent: true },
    runtimeMetadata: {},
  });
  const newParent = createEvidenceNode({
    type: 'fixture-parent',
    nodeSchema: 'fixture.parent.v1',
    evaluator: 'fixture.parent.v1',
    policyDigest: 'a'.repeat(64),
    exactInputDigests: { source: 'c'.repeat(64) },
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: 'fixture.parent-output.v1',
    output: { equivalent: true },
    runtimeMetadata: {},
  });
  const descendant = createEvidenceNode({
    type: 'fixture-descendant',
    nodeSchema: 'fixture.descendant.v1',
    evaluator: 'fixture.descendant.v1',
    policyDigest: 'd'.repeat(64),
    exactInputDigests: { requirement: 'e'.repeat(64) },
    semanticParentResultDigests: { source: oldParent.resultDigest },
    provenanceParentNodeIds: { source: oldParent.nodeId },
    outputSchema: 'fixture.descendant-output.v1',
    output: { valid: true },
    runtimeMetadata: {},
  });
  const convergence = createConvergenceRecord({
    oldParent,
    newParent,
    validatorVersion: 'evidence-currentness.v1',
    runtimeMetadata: {},
  });
  const reuseProof = createDescendantReuseProof({
    descendant,
    parentRole: 'source',
    oldParent,
    newParent,
    convergenceRecord: convergence,
    validatorVersion: 'evidence-currentness.v1',
    runtimeMetadata: {},
  });
  const nodes = [
    oldParent,
    newParent,
    descendant,
    convergence,
    reuseProof,
  ].sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  const base = {
    schemaVersion: 1 as const,
    kind: 'investigation-artifact' as const,
    changeId: 'demo-change',
    legacyMigration: false,
    nodes,
    currentRefs: { sealedInvestigation: descendant.nodeId },
  };
  const roleDigest = crypto
    .createHash('sha256')
    .update('source', 'utf8')
    .digest('hex');
  const currentParentRef = `current-parent/${descendant.nodeId}/${roleDigest}`;
  const reuseProofRef = `reuse-proof/${descendant.nodeId}/${roleDigest}`;

  for (const currentRefs of [
    base.currentRefs,
    { ...base.currentRefs, [currentParentRef]: newParent.nodeId },
    { ...base.currentRefs, [reuseProofRef]: reuseProof.nodeId },
  ]) {
    assert.throws(
      () => parseInvestigationArtifact({ ...base, currentRefs }, 'demo-change'),
      (error) => workflowCode(error) === 'INVALID_INVESTIGATION_ARTIFACT',
    );
  }

  const current = {
    ...base,
    currentRefs: {
      ...base.currentRefs,
      [currentParentRef]: newParent.nodeId,
      [reuseProofRef]: reuseProof.nodeId,
    },
  };
  assert.deepEqual(parseInvestigationArtifact(current, 'demo-change'), current);
});

test('projection retains one old descendant only through a generated current reuse path', () => {
  const oldParent = parentNode('b'.repeat(64));
  const newParent = parentNode('c'.repeat(64));
  const oldDescendant = descendantNode(oldParent);
  const recomputedDescendant = descendantNode(newParent);

  const projected = projectConvergedEvidenceGraph({
    previousNodes: [oldParent, oldDescendant].sort(byNodeId),
    previousCurrentRefs: { sealedInvestigation: oldDescendant.nodeId },
    nextNodes: [newParent, recomputedDescendant].sort(byNodeId),
    nextCurrentRefs: { sealedInvestigation: recomputedDescendant.nodeId },
  });

  assert.equal(projected.currentRefs.sealedInvestigation, oldDescendant.nodeId);
  assert.deepEqual(projected.reusedDescendantNodeIds, [oldDescendant.nodeId]);
  assert.equal(projected.convergenceNodeIds.length, 1);
  assert.equal(projected.reuseProofNodeIds.length, 1);
  assert.equal(
    projected.currentRefs[
      currentParentEvidenceRef(oldDescendant.nodeId, 'source')
    ],
    newParent.nodeId,
  );
  assert.equal(
    projected.currentRefs[
      descendantReuseProofEvidenceRef(oldDescendant.nodeId, 'source')
    ],
    projected.reuseProofNodeIds[0],
  );
  const artifact = {
    schemaVersion: 1 as const,
    kind: 'investigation-artifact' as const,
    changeId: 'demo-change',
    legacyMigration: false,
    nodes: projected.nodes,
    currentRefs: projected.currentRefs,
  };
  assert.deepEqual(
    parseInvestigationArtifact(artifact, 'demo-change'),
    artifact,
  );
});

function parentNode(source: string) {
  return createEvidenceNode({
    type: 'fixture-parent',
    nodeSchema: 'fixture.parent.v1',
    evaluator: 'fixture.parent.v1',
    policyDigest: 'a'.repeat(64),
    exactInputDigests: { source },
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: 'fixture.parent-output.v1',
    output: { equivalent: true },
    runtimeMetadata: {},
  });
}

function descendantNode(parent: ReturnType<typeof parentNode>) {
  return createEvidenceNode({
    type: 'fixture-descendant',
    nodeSchema: 'fixture.descendant.v1',
    evaluator: 'fixture.descendant.v1',
    policyDigest: 'd'.repeat(64),
    exactInputDigests: { requirement: 'e'.repeat(64) },
    semanticParentResultDigests: { source: parent.resultDigest },
    provenanceParentNodeIds: { source: parent.nodeId },
    outputSchema: 'fixture.descendant-output.v1',
    output: { valid: true },
    runtimeMetadata: {},
  });
}

function byNodeId(left: { nodeId: string }, right: { nodeId: string }): number {
  return left.nodeId.localeCompare(right.nodeId);
}

function workflowCode(error: unknown): string | null {
  return error instanceof WorkflowError ? error.code : null;
}
