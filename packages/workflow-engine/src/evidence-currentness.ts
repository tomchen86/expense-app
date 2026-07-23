import { ExitCode, workflowError } from './errors.ts';
import {
  parentsCompatible,
  readConvergenceBinding,
  readReuseProofBinding,
} from './evidence-convergence.ts';
import {
  assertStoredEvidenceNode,
  type EvidenceNode,
} from './evidence-node.ts';

const IDENTITY_FIELDS = [
  'type',
  'evaluator',
  'policyDigest',
  'nodeSchema',
  'outputSchema',
] as const;

export type EvidenceCompatibilityIdentity = Pick<
  EvidenceNode,
  (typeof IDENTITY_FIELDS)[number]
>;

/**
 * Currentness is dependency-specific: there is no global valid/stale bit. A
 * changed exact input stales only the evaluated node. Every declared provenance
 * edge is resolved against its prior and current parent evidence: the descendant
 * declaration must be coherent, the prior parent must match the recorded id and
 * semantic result, and an unchanged edge must still carry that result. A parent
 * whose `nodeId` changed may be reused only when its prior and current artifacts
 * are independently compatible and covered by one convergence record and exactly
 * one unambiguous reuse proof for that edge. Any failed check leaves the role
 * unauthorized and the node stale.
 */
export type EvidenceCurrentnessInput = {
  node: EvidenceNode;
  expectedIdentity: EvidenceCompatibilityIdentity;
  expectedExactInputDigests: Record<string, string>;
  previousParents: Record<string, EvidenceNode>;
  currentParents: Record<string, EvidenceNode>;
  convergenceRecords: EvidenceNode[];
  reuseProofs: EvidenceNode[];
  validatorVersion: string;
};

export type EvidenceCurrentnessResult = {
  current: boolean;
  reusedParentRoles: string[];
  staleReasons: string[];
};

export function evaluateEvidenceCurrentness(
  input: EvidenceCurrentnessInput,
): EvidenceCurrentnessResult {
  const node = assertStoredEvidenceNode(input.node, currentnessInvalid);
  const expectedIdentity = assertExpectedIdentity(input.expectedIdentity);
  const convergences = input.convergenceRecords.map((record) =>
    assertStoredEvidenceNode(record, currentnessInvalid),
  );
  const proofs = input.reuseProofs.map((proof) =>
    assertStoredEvidenceNode(proof, currentnessInvalid),
  );

  const staleReasons: string[] = [];
  const reusedParentRoles: string[] = [];

  // Currentness is scoped to one reviewed evaluator/policy/schema identity.
  // Equal inputs and parents cannot rehabilitate evidence from another version.
  for (const field of IDENTITY_FIELDS) {
    if (node[field] !== expectedIdentity[field]) {
      staleReasons.push(`identity:${field}`);
    }
  }

  // A changed exact input stales only this node.
  const inputRoles = new Set([
    ...Object.keys(input.expectedExactInputDigests),
    ...Object.keys(node.exactInputDigests),
  ]);
  for (const role of inputRoles) {
    if (
      input.expectedExactInputDigests[role] !== node.exactInputDigests[role]
    ) {
      staleReasons.push(`exact-input:${role}`);
    }
  }

  // The descendant must declare each edge coherently across provenance and
  // semantic maps; any role present in only one is a declaration failure.
  const provenanceRoles = new Set(Object.keys(node.provenanceParentNodeIds));
  const semanticRoles = new Set(Object.keys(node.semanticParentResultDigests));
  const declaredRoles: string[] = [];
  for (const role of new Set([...provenanceRoles, ...semanticRoles])) {
    if (provenanceRoles.has(role) && semanticRoles.has(role)) {
      declaredRoles.push(role);
    } else {
      staleReasons.push(`parent-declaration:${role}`);
    }
  }

  // A prior or current parent supplied for an undeclared edge fails closed.
  for (const role of Object.keys(input.currentParents)) {
    if (!provenanceRoles.has(role)) {
      staleReasons.push(`parent-unexpected:${role}`);
    }
  }
  for (const role of Object.keys(input.previousParents)) {
    if (!provenanceRoles.has(role)) {
      staleReasons.push(`parent-prior-unexpected:${role}`);
    }
  }

  for (const role of declaredRoles) {
    const recordedNodeId = node.provenanceParentNodeIds[role];
    const recordedResult = node.semanticParentResultDigests[role];

    const rawCurrent = input.currentParents[role];
    if (rawCurrent === undefined) {
      staleReasons.push(`parent-missing:${role}`);
      continue;
    }
    const rawPrevious = input.previousParents[role];
    if (rawPrevious === undefined) {
      staleReasons.push(`parent-prior-missing:${role}`);
      continue;
    }
    const previous = assertStoredEvidenceNode(rawPrevious, currentnessInvalid);
    const current = assertStoredEvidenceNode(rawCurrent, currentnessInvalid);

    // The prior parent must be the recorded provenance evidence.
    if (previous.nodeId !== recordedNodeId) {
      staleReasons.push(`parent-prior-missing:${role}`);
      continue;
    }
    // The descendant-recorded semantic result must be the true prior result.
    if (previous.resultDigest !== recordedResult) {
      staleReasons.push(`parent-result:${role}`);
      continue;
    }

    if (current.nodeId === recordedNodeId) {
      // Unchanged edge: the current parent must still carry the recorded result.
      if (current.resultDigest !== recordedResult) {
        staleReasons.push(`parent-result:${role}`);
      }
      continue;
    }

    // Changed edge: independently confirm the prior/current artifacts are
    // compatible before trusting any convergence or proof record.
    if (
      !parentsCompatible(previous, current) ||
      current.resultDigest !== recordedResult
    ) {
      staleReasons.push(`convergence:${role}`);
      continue;
    }

    // A matched convergence must bind this exact edge and independently agree
    // with the resolved current (and, by compatibility, previous) parent on
    // every compatibility claim and on the envelope policy.
    const matchedConvergenceIds = new Set<string>();
    for (const record of convergences) {
      const binding = readConvergenceBinding(record);
      if (
        binding &&
        binding.validatorVersion === input.validatorVersion &&
        binding.oldParentNode === recordedNodeId &&
        binding.newParentNode === current.nodeId &&
        binding.sharedResultDigest === recordedResult &&
        binding.sharedType === current.type &&
        binding.sharedEvaluator === current.evaluator &&
        binding.sharedPolicyDigest === current.policyDigest &&
        binding.sharedNodeSchema === current.nodeSchema &&
        binding.sharedOutputSchema === current.outputSchema &&
        record.policyDigest === current.policyDigest
      ) {
        matchedConvergenceIds.add(record.nodeId);
      }
    }
    if (matchedConvergenceIds.size === 0) {
      staleReasons.push(`convergence:${role}`);
      continue;
    }

    // A matched proof must be sealed under the descendant's own policy and
    // attest the descendant-recorded shared result for this exact edge.
    let matchCount = 0;
    for (const proof of proofs) {
      const binding = readReuseProofBinding(proof);
      if (
        binding &&
        binding.validatorVersion === input.validatorVersion &&
        binding.parentRole === role &&
        binding.descendantNode === node.nodeId &&
        binding.oldParentNode === recordedNodeId &&
        binding.newParentNode === current.nodeId &&
        binding.sharedResultDigest === recordedResult &&
        proof.policyDigest === node.policyDigest &&
        matchedConvergenceIds.has(binding.convergenceNode)
      ) {
        matchCount += 1;
      }
    }
    if (matchCount === 0) {
      staleReasons.push(`reuse-proof:${role}`);
    } else if (matchCount > 1) {
      staleReasons.push(`reuse-proof-ambiguous:${role}`);
    } else {
      reusedParentRoles.push(role);
    }
  }

  staleReasons.sort();
  reusedParentRoles.sort();
  return {
    current: staleReasons.length === 0,
    reusedParentRoles,
    staleReasons,
  };
}

/**
 * Validate a closed, topologically ordered ordinary dependency DAG over its
 * provenance edges. Every node envelope is revalidated by recomputing both
 * digests, so a node whose stored id or result was forged fails closed. Node
 * types are open — any well-formed future node (for example an investigation-why
 * node) is accepted — but each node's semantic-parent roles must correspond
 * exactly to its provenance-parent roles, and every recorded semantic result
 * must equal the resolved parent's result. A duplicate `nodeId` (including a
 * same-id/different-output collision), a provenance edge to a node absent from
 * the set, a semantic/provenance role mismatch, a forged parent result, or a
 * provenance cycle is rejected. Convergence and reuse-proof records keep their
 * own dedicated validators and are not ordinary dependency nodes here. The
 * returned topological order is deterministic regardless of input order: ready
 * nodes are always emitted in ascending `nodeId` order, so a pure sink such as
 * an investigation coverage node lands last.
 */
export function validateClosedEvidenceDag(nodes: EvidenceNode[]): {
  topologicalNodeIds: string[];
} {
  const validated = nodes.map((node) =>
    assertStoredEvidenceNode(node, dagInvalid),
  );

  const byId = new Map<string, EvidenceNode>();
  for (const node of validated) {
    if (byId.has(node.nodeId)) {
      throw dagInvalid();
    }
    byId.set(node.nodeId, node);
  }

  const remainingIndegree = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const node of validated) {
    remainingIndegree.set(node.nodeId, 0);
    children.set(node.nodeId, []);
  }
  for (const node of validated) {
    const provenanceRoles = Object.keys(node.provenanceParentNodeIds);
    const semanticRoles = Object.keys(node.semanticParentResultDigests);
    if (
      provenanceRoles.length !== semanticRoles.length ||
      !provenanceRoles.every((role) =>
        Object.prototype.hasOwnProperty.call(
          node.semanticParentResultDigests,
          role,
        ),
      )
    ) {
      throw dagInvalid();
    }
    const parents = new Set<string>();
    for (const role of provenanceRoles) {
      const parentId = node.provenanceParentNodeIds[role]!;
      const parent = byId.get(parentId);
      if (!parent) {
        throw dagInvalid();
      }
      if (node.semanticParentResultDigests[role] !== parent.resultDigest) {
        throw dagInvalid();
      }
      parents.add(parentId);
    }
    for (const parentId of parents) {
      children.get(parentId)!.push(node.nodeId);
    }
    remainingIndegree.set(node.nodeId, parents.size);
  }

  const ready: string[] = [];
  for (const [nodeId, indegree] of remainingIndegree) {
    if (indegree === 0) {
      ready.push(nodeId);
    }
  }
  const order: string[] = [];
  while (ready.length > 0) {
    ready.sort();
    const nodeId = ready.shift()!;
    order.push(nodeId);
    for (const child of children.get(nodeId)!) {
      const next = remainingIndegree.get(child)! - 1;
      remainingIndegree.set(child, next);
      if (next === 0) {
        ready.push(child);
      }
    }
  }
  if (order.length !== validated.length) {
    throw dagInvalid();
  }
  return { topologicalNodeIds: order };
}

function dagInvalid() {
  return workflowError(
    'EVIDENCE_DAG_INVALID',
    'Closed evidence DAG is malformed.',
    ExitCode.usage,
  );
}

function assertExpectedIdentity(value: unknown): EvidenceCompatibilityIdentity {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== IDENTITY_FIELDS.length ||
    !IDENTITY_FIELDS.every((field) =>
      Object.prototype.hasOwnProperty.call(value, field),
    )
  ) {
    throw currentnessInvalid();
  }
  const identity = value as Record<string, unknown>;
  if (
    typeof identity.type !== 'string' ||
    identity.type.length === 0 ||
    typeof identity.evaluator !== 'string' ||
    identity.evaluator.length === 0 ||
    typeof identity.policyDigest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(identity.policyDigest) ||
    typeof identity.nodeSchema !== 'string' ||
    identity.nodeSchema.length === 0 ||
    typeof identity.outputSchema !== 'string' ||
    identity.outputSchema.length === 0
  ) {
    throw currentnessInvalid();
  }
  return identity as EvidenceCompatibilityIdentity;
}

function currentnessInvalid() {
  return workflowError(
    'EVIDENCE_CURRENTNESS_INVALID',
    'Evidence currentness input is malformed.',
    ExitCode.usage,
  );
}
