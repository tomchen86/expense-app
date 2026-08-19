import crypto from 'node:crypto';

import { canonicalJson } from '../../../foundation/canonical-json/canonical-json.ts';
import {
  createConvergenceRecord,
  createDescendantReuseProof,
  parentsCompatible,
  readConvergenceBinding,
  readReuseProofBinding,
} from './evidence-convergence.ts';
import {
  evaluateEvidenceCurrentness,
  validateClosedEvidenceDag,
} from './evidence-currentness.ts';
import {
  assertStoredEvidenceNode,
  createEvidenceNode,
  type EvidenceNode,
} from './evidence-node.ts';
import { ExitCode, workflowError } from '../../../foundation/errors/errors.ts';

export const EVIDENCE_CURRENTNESS_VALIDATOR_VERSION = 'evidence-currentness.v1';

const INVENTORY_CURRENTNESS_TYPE = 'investigation-inventory-currentness';
const INVENTORY_CURRENTNESS_SCHEMA = 'investigation.inventory-currentness.v1';
const INVENTORY_CURRENTNESS_EVALUATOR =
  'investigation.inventory-currentness.v1';
const INVENTORY_CURRENTNESS_OUTPUT_SCHEMA =
  'investigation.inventory-currentness-output.v1';
const INVENTORY_TYPE = 'investigation-tree-inventory';
const INVENTORY_SCHEMA = 'investigation.tree-inventory.v1';
const INVENTORY_EVALUATOR = 'investigation-scanner.v1';
const INVENTORY_OUTPUT_SCHEMA = 'investigation.tree-inventory-output.v1';
export const SEALED_INVESTIGATION_REUSE_SCHEMA = 'investigation.seal.v2';
export const SEALED_INVESTIGATION_REUSE_EVALUATOR = 'workflow-propose.v2';
export const SEALED_INVESTIGATION_REUSE_OUTPUT_SCHEMA =
  'investigation.seal-output.v2';
const INVENTORY_CURRENTNESS_POLICY_DIGEST = crypto
  .createHash('sha256')
  .update(
    canonicalJson({
      schema: 'investigation.inventory-currentness-policy.v1',
      validatorVersion: EVIDENCE_CURRENTNESS_VALIDATOR_VERSION,
    }),
    'utf8',
  )
  .digest('hex');

const DIGEST = '[0-9a-f]{64}';
const CURRENT_PARENT_REF = new RegExp(
  `^current-parent/(${DIGEST})/(${DIGEST})$`,
);
const REUSE_PROOF_REF = new RegExp(`^reuse-proof/(${DIGEST})/(${DIGEST})$`);

type ReusePathPair = Readonly<{
  key: string;
  descendantNodeId: string;
  parentRoleDigest: string;
  newParentNodeId: string;
  proofNodeId: string;
  parentRole: string;
  proof: EvidenceNode;
  convergence: EvidenceNode;
}>;

export type ConvergedEvidenceGraphProjection = Readonly<{
  nodes: EvidenceNode[];
  currentRefs: Record<string, string>;
  reusedDescendantNodeIds: string[];
  convergenceNodeIds: string[];
  reuseProofNodeIds: string[];
}>;

/**
 * Bind the semantic inventory result to the exact inventory node that produced
 * it. The seal depends on this node, so a replacement inventory whose semantic
 * result converges can retain the prior currentness node only through the
 * tracked convergence/proof path validated below.
 */
export function createInvestigationInventoryCurrentnessNode(
  inventoryNode: EvidenceNode,
): EvidenceNode {
  const inventory = assertStoredEvidenceNode(inventoryNode, reusePathInvalid);
  if (
    inventory.type !== INVENTORY_TYPE ||
    inventory.nodeSchema !== INVENTORY_SCHEMA ||
    inventory.evaluator !== INVENTORY_EVALUATOR ||
    inventory.outputSchema !== INVENTORY_OUTPUT_SCHEMA
  ) {
    throw reusePathInvalid();
  }
  return createEvidenceNode({
    type: INVENTORY_CURRENTNESS_TYPE,
    nodeSchema: INVENTORY_CURRENTNESS_SCHEMA,
    evaluator: INVENTORY_CURRENTNESS_EVALUATOR,
    policyDigest: INVENTORY_CURRENTNESS_POLICY_DIGEST,
    exactInputDigests: {},
    semanticParentResultDigests: { inventory: inventory.resultDigest },
    provenanceParentNodeIds: { inventory: inventory.nodeId },
    outputSchema: INVENTORY_CURRENTNESS_OUTPUT_SCHEMA,
    output: {
      inventoryResultDigest: inventory.resultDigest,
      complete: true,
    },
    runtimeMetadata: {},
  });
}

export function assertInvestigationInventoryCurrentnessNode(
  node: EvidenceNode,
): EvidenceNode {
  const currentness = assertStoredEvidenceNode(node, reusePathInvalid);
  if (
    currentness.type !== INVENTORY_CURRENTNESS_TYPE ||
    currentness.nodeSchema !== INVENTORY_CURRENTNESS_SCHEMA ||
    currentness.evaluator !== INVENTORY_CURRENTNESS_EVALUATOR ||
    currentness.policyDigest !== INVENTORY_CURRENTNESS_POLICY_DIGEST ||
    currentness.outputSchema !== INVENTORY_CURRENTNESS_OUTPUT_SCHEMA ||
    Object.keys(currentness.exactInputDigests).length !== 0 ||
    canonicalJson(Object.keys(currentness.semanticParentResultDigests)) !==
      canonicalJson(['inventory']) ||
    canonicalJson(Object.keys(currentness.provenanceParentNodeIds)) !==
      canonicalJson(['inventory']) ||
    typeof currentness.output !== 'object' ||
    currentness.output === null ||
    Array.isArray(currentness.output)
  ) {
    throw reusePathInvalid();
  }
  const output = currentness.output as Record<string, unknown>;
  if (
    canonicalJson(Object.keys(output).sort()) !==
      canonicalJson(['complete', 'inventoryResultDigest']) ||
    output.complete !== true ||
    output.inventoryResultDigest !==
      currentness.semanticParentResultDigests.inventory
  ) {
    throw reusePathInvalid();
  }
  return currentness;
}

export function evidenceParentRoleDigest(parentRole: string): string {
  if (parentRole.length === 0) throw reusePathInvalid();
  return crypto.createHash('sha256').update(parentRole, 'utf8').digest('hex');
}

export function currentParentEvidenceRef(
  descendantNodeId: string,
  parentRole: string,
): string {
  assertDigest(descendantNodeId);
  return `current-parent/${descendantNodeId}/${evidenceParentRoleDigest(parentRole)}`;
}

export function descendantReuseProofEvidenceRef(
  descendantNodeId: string,
  parentRole: string,
): string {
  assertDigest(descendantNodeId);
  return `reuse-proof/${descendantNodeId}/${evidenceParentRoleDigest(parentRole)}`;
}

/**
 * Validate the engine-owned current path for every retained descendant. A
 * changed edge is represented by two exact refs: one selects the current parent
 * and one selects the immutable proof. The proof and its convergence record are
 * accepted only when the descendant is reachable from an ordinary current ref,
 * every changed role is paired exactly once, and the shared currentness
 * evaluator independently accepts the complete direct-parent set.
 */
export function validateTrackedEvidenceReusePaths(
  nodes: readonly EvidenceNode[],
  currentRefs: Readonly<Record<string, string>>,
): void {
  const validated = nodes.map((node) =>
    assertStoredEvidenceNode(node, reusePathInvalid),
  );
  const byId = new Map(validated.map((node) => [node.nodeId, node]));
  for (const node of validated) {
    if (node.type === INVENTORY_CURRENTNESS_TYPE) {
      assertInvestigationInventoryCurrentnessNode(node);
      const inventory = byId.get(node.provenanceParentNodeIds.inventory!);
      if (
        !inventory ||
        createInvestigationInventoryCurrentnessNode(inventory).nodeId !==
          node.nodeId
      ) {
        throw reusePathInvalid();
      }
    }
    if (
      node.type === 'sealed-investigation' &&
      node.nodeSchema === SEALED_INVESTIGATION_REUSE_SCHEMA
    ) {
      const currentnessId =
        node.provenanceParentNodeIds['inventory-currentness'];
      const currentness = currentnessId ? byId.get(currentnessId) : undefined;
      if (
        node.evaluator !== SEALED_INVESTIGATION_REUSE_EVALUATOR ||
        node.outputSchema !== SEALED_INVESTIGATION_REUSE_OUTPUT_SCHEMA ||
        !currentness ||
        node.semanticParentResultDigests['inventory-currentness'] !==
          currentness.resultDigest
      ) {
        throw reusePathInvalid();
      }
      assertInvestigationInventoryCurrentnessNode(currentness);
    }
  }
  const currentParents = new Map<string, string>();
  const reuseProofs = new Map<string, string>();
  const ordinaryRootIds: string[] = [];

  for (const [refName, nodeId] of Object.entries(currentRefs)) {
    const parentMatch = CURRENT_PARENT_REF.exec(refName);
    const proofMatch = REUSE_PROOF_REF.exec(refName);
    if (parentMatch) {
      currentParents.set(`${parentMatch[1]}/${parentMatch[2]}`, nodeId);
      continue;
    }
    if (proofMatch) {
      reuseProofs.set(`${proofMatch[1]}/${proofMatch[2]}`, nodeId);
      continue;
    }
    if (
      refName.startsWith('current-parent/') ||
      refName.startsWith('reuse-proof/')
    ) {
      throw reusePathInvalid();
    }
    ordinaryRootIds.push(nodeId);
  }

  const specialNodes = validated.filter(isReusePathNode);
  if (currentParents.size === 0 && reuseProofs.size === 0) {
    if (specialNodes.length > 0) throw reusePathInvalid();
    return;
  }
  if (
    currentParents.size !== reuseProofs.size ||
    [...currentParents.keys()].some((key) => !reuseProofs.has(key))
  ) {
    throw reusePathInvalid();
  }

  const pairs: ReusePathPair[] = [];
  const consumedProofIds = new Set<string>();
  const consumedConvergenceIds = new Set<string>();
  for (const [key, newParentNodeId] of currentParents) {
    const [descendantNodeId, parentRoleDigest] = key.split('/');
    const proofNodeId = reuseProofs.get(key)!;
    const descendant = byId.get(descendantNodeId);
    const newParent = byId.get(newParentNodeId);
    const proof = byId.get(proofNodeId);
    const binding = proof ? readReuseProofBinding(proof) : null;
    const convergence = binding ? byId.get(binding.convergenceNode) : undefined;
    const convergenceBinding = convergence
      ? readConvergenceBinding(convergence)
      : null;
    if (
      !descendant ||
      !newParent ||
      !proof ||
      !binding ||
      !convergence ||
      !convergenceBinding ||
      isReusePathNode(descendant) ||
      isReusePathNode(newParent) ||
      binding.validatorVersion !== EVIDENCE_CURRENTNESS_VALIDATOR_VERSION ||
      binding.descendantNode !== descendantNodeId ||
      binding.newParentNode !== newParentNodeId ||
      binding.parentRole.length === 0 ||
      evidenceParentRoleDigest(binding.parentRole) !== parentRoleDigest ||
      descendant.provenanceParentNodeIds[binding.parentRole] !==
        binding.oldParentNode ||
      convergenceBinding.oldParentNode !== binding.oldParentNode ||
      convergenceBinding.newParentNode !== binding.newParentNode ||
      convergenceBinding.sharedResultDigest !== binding.sharedResultDigest
    ) {
      throw reusePathInvalid();
    }
    consumedProofIds.add(proof.nodeId);
    consumedConvergenceIds.add(convergence.nodeId);
    pairs.push({
      key,
      descendantNodeId,
      parentRoleDigest,
      newParentNodeId,
      proofNodeId,
      parentRole: binding.parentRole,
      proof,
      convergence,
    });
  }

  if (
    specialNodes.some(
      (node) =>
        (node.type === 'evidence-reuse-proof' &&
          !consumedProofIds.has(node.nodeId)) ||
        (node.type === 'evidence-convergence' &&
          !consumedConvergenceIds.has(node.nodeId)),
    )
  ) {
    throw reusePathInvalid();
  }

  const reachable = new Set<string>();
  const addOrdinaryClosure = (rootId: string): void => {
    const pending = [rootId];
    while (pending.length > 0) {
      const nodeId = pending.pop()!;
      if (reachable.has(nodeId)) continue;
      const node = byId.get(nodeId);
      if (!node || isReusePathNode(node)) throw reusePathInvalid();
      reachable.add(nodeId);
      pending.push(...Object.values(node.provenanceParentNodeIds));
    }
  };
  ordinaryRootIds.forEach(addOrdinaryClosure);
  let changed = true;
  while (changed) {
    changed = false;
    for (const pair of pairs) {
      if (
        reachable.has(pair.descendantNodeId) &&
        !reachable.has(pair.newParentNodeId)
      ) {
        addOrdinaryClosure(pair.newParentNodeId);
        changed = true;
      }
    }
  }
  if (pairs.some((pair) => !reachable.has(pair.descendantNodeId))) {
    throw reusePathInvalid();
  }

  const byDescendant = new Map<string, ReusePathPair[]>();
  for (const pair of pairs) {
    const grouped = byDescendant.get(pair.descendantNodeId) ?? [];
    grouped.push(pair);
    byDescendant.set(pair.descendantNodeId, grouped);
  }
  for (const [descendantNodeId, descendantPairs] of byDescendant) {
    const descendant = byId.get(descendantNodeId)!;
    const previousParents: Record<string, EvidenceNode> = {};
    const resolvedCurrentParents: Record<string, EvidenceNode> = {};
    for (const [role, parentNodeId] of Object.entries(
      descendant.provenanceParentNodeIds,
    )) {
      const parent = byId.get(parentNodeId);
      if (!parent || isReusePathNode(parent)) throw reusePathInvalid();
      previousParents[role] = parent;
      resolvedCurrentParents[role] = parent;
    }
    for (const pair of descendantPairs) {
      if (
        resolvedCurrentParents[pair.parentRole]?.nodeId !== pair.newParentNodeId
      ) {
        const next = byId.get(pair.newParentNodeId);
        if (!next) throw reusePathInvalid();
        resolvedCurrentParents[pair.parentRole] = next;
      } else {
        throw reusePathInvalid();
      }
    }
    const result = evaluateEvidenceCurrentness({
      node: descendant,
      expectedIdentity: {
        type: descendant.type,
        evaluator: descendant.evaluator,
        policyDigest: descendant.policyDigest,
        nodeSchema: descendant.nodeSchema,
        outputSchema: descendant.outputSchema,
      },
      expectedExactInputDigests: { ...descendant.exactInputDigests },
      previousParents,
      currentParents: resolvedCurrentParents,
      convergenceRecords: descendantPairs.map(({ convergence }) => convergence),
      reuseProofs: descendantPairs.map(({ proof }) => proof),
      validatorVersion: EVIDENCE_CURRENTNESS_VALIDATOR_VERSION,
    });
    if (
      !result.current ||
      canonicalJson(result.reusedParentRoles) !==
        canonicalJson(
          descendantPairs.map(({ parentRole }) => parentRole).sort(),
        )
    ) {
      throw reusePathInvalid();
    }
  }
}

/**
 * Project a freshly recomputed ordinary DAG onto a prior current graph. The
 * producer never edits an old node. It first remaps every fresh parent to the
 * already selected current parent, then retains a unique prior descendant only
 * when its direct inputs/output identity are exact and every changed parent is
 * independently compatible with an equal semantic result. Each changed edge
 * receives a new convergence record, proof, and paired current ref. Ambiguous
 * prior candidates or any incompatible edge conservatively keep the fresh
 * descendant.
 */
export function projectConvergedEvidenceGraph(input: {
  previousNodes: readonly EvidenceNode[];
  previousCurrentRefs: Readonly<Record<string, string>>;
  nextNodes: readonly EvidenceNode[];
  nextCurrentRefs: Readonly<Record<string, string>>;
}): ConvergedEvidenceGraphProjection {
  validateTrackedEvidenceReusePaths(
    input.previousNodes,
    input.previousCurrentRefs,
  );
  if (
    input.nextNodes.some(
      (node) =>
        isReusePathNode(node) || Object.keys(node.runtimeMetadata).length !== 0,
    ) ||
    Object.keys(input.nextCurrentRefs).some(
      (name) =>
        name.startsWith('current-parent/') || name.startsWith('reuse-proof/'),
    )
  ) {
    throw reusePathInvalid();
  }

  const nextNodes = input.nextNodes.map((node) =>
    assertStoredEvidenceNode(node, reusePathInvalid),
  );
  const previousNodes = input.previousNodes.map((node) =>
    assertStoredEvidenceNode(node, reusePathInvalid),
  );
  const nextById = new Map(nextNodes.map((node) => [node.nodeId, node]));
  const previousById = new Map(
    previousNodes.map((node) => [node.nodeId, node]),
  );
  const topological = validateClosedEvidenceDag(nextNodes).topologicalNodeIds;
  const nextReachable = reachableCurrentOrdinaryNodeIds(
    nextNodes,
    input.nextCurrentRefs,
  );
  const priorReachable = reachableCurrentOrdinaryNodeIds(
    previousNodes,
    input.previousCurrentRefs,
  );
  const priorCandidates = new Map<string, EvidenceNode[]>();
  for (const nodeId of priorReachable) {
    const node = previousById.get(nodeId)!;
    if (isReusePathNode(node)) continue;
    const key = reusableNodeKey(node);
    const candidates = priorCandidates.get(key) ?? [];
    candidates.push(node);
    priorCandidates.set(key, candidates);
  }

  const selectedByFreshId = new Map<string, EvidenceNode>();
  const selectedNodes = new Map<string, EvidenceNode>();
  const convergenceNodes = new Map<string, EvidenceNode>();
  const proofNodes = new Map<string, EvidenceNode>();
  const reusedDescendantIds = new Set<string>();
  const claimedPriorNodeIds = new Set<string>();

  for (const freshNodeId of topological) {
    const fresh = nextById.get(freshNodeId)!;
    const remappedParents: Record<string, string> = {};
    for (const [role, parentNodeId] of Object.entries(
      fresh.provenanceParentNodeIds,
    )) {
      const selectedParent = selectedByFreshId.get(parentNodeId);
      if (
        !selectedParent ||
        selectedParent.resultDigest !== fresh.semanticParentResultDigests[role]
      ) {
        throw reusePathInvalid();
      }
      remappedParents[role] = selectedParent.nodeId;
    }
    const remapped = createEvidenceNode({
      type: fresh.type,
      nodeSchema: fresh.nodeSchema,
      evaluator: fresh.evaluator,
      policyDigest: fresh.policyDigest,
      exactInputDigests: { ...fresh.exactInputDigests },
      semanticParentResultDigests: {
        ...fresh.semanticParentResultDigests,
      },
      provenanceParentNodeIds: remappedParents,
      outputSchema: fresh.outputSchema,
      output: fresh.output,
      runtimeMetadata: {},
    });
    const candidates = nextReachable.has(fresh.nodeId)
      ? (priorCandidates.get(reusableNodeKey(remapped)) ?? [])
      : [];
    const exact = candidates.find(({ nodeId }) => nodeId === remapped.nodeId);
    let selected = exact ?? remapped;
    if (
      !exact &&
      candidates.length === 1 &&
      !claimedPriorNodeIds.has(candidates[0]!.nodeId)
    ) {
      const candidate = candidates[0]!;
      const edgeProofs: Array<{
        convergence: EvidenceNode;
        proof: EvidenceNode;
      }> = [];
      let compatible = true;
      let changedParent = false;
      for (const [role, oldParentNodeId] of Object.entries(
        candidate.provenanceParentNodeIds,
      )) {
        const oldParent = previousById.get(oldParentNodeId);
        const currentParentId = remapped.provenanceParentNodeIds[role];
        const currentParent = selectedNodes.get(currentParentId);
        if (!oldParent || !currentParent) {
          compatible = false;
          break;
        }
        if (oldParent.nodeId === currentParent.nodeId) continue;
        changedParent = true;
        if (!parentsCompatible(oldParent, currentParent)) {
          compatible = false;
          break;
        }
        const convergence = createConvergenceRecord({
          oldParent,
          newParent: currentParent,
          validatorVersion: EVIDENCE_CURRENTNESS_VALIDATOR_VERSION,
          runtimeMetadata: {},
        });
        const proof = createDescendantReuseProof({
          descendant: candidate,
          parentRole: role,
          oldParent,
          newParent: currentParent,
          convergenceRecord: convergence,
          validatorVersion: EVIDENCE_CURRENTNESS_VALIDATOR_VERSION,
          runtimeMetadata: {},
        });
        edgeProofs.push({ convergence, proof });
      }
      if (compatible && changedParent) {
        selected = candidate;
        claimedPriorNodeIds.add(candidate.nodeId);
        reusedDescendantIds.add(candidate.nodeId);
        for (const { convergence, proof } of edgeProofs) {
          convergenceNodes.set(convergence.nodeId, convergence);
          proofNodes.set(proof.nodeId, proof);
        }
      }
    }
    selectedByFreshId.set(fresh.nodeId, selected);
    selectedNodes.set(selected.nodeId, selected);
  }

  const currentRefs: Record<string, string> = {};
  for (const [name, freshNodeId] of Object.entries(input.nextCurrentRefs)) {
    const selected = selectedByFreshId.get(freshNodeId);
    if (!selected) throw reusePathInvalid();
    currentRefs[name] = selected.nodeId;
  }
  for (const proof of proofNodes.values()) {
    const binding = readReuseProofBinding(proof);
    if (!binding) throw reusePathInvalid();
    currentRefs[
      currentParentEvidenceRef(binding.descendantNode, binding.parentRole)
    ] = binding.newParentNode;
    currentRefs[
      descendantReuseProofEvidenceRef(
        binding.descendantNode,
        binding.parentRole,
      )
    ] = proof.nodeId;
  }

  const outputNodes = new Map<string, EvidenceNode>([
    ...selectedNodes,
    ...convergenceNodes,
    ...proofNodes,
  ]);
  const includePriorAncestry = (nodeId: string): void => {
    if (outputNodes.has(nodeId)) return;
    const node = previousById.get(nodeId);
    if (!node || isReusePathNode(node)) throw reusePathInvalid();
    outputNodes.set(node.nodeId, node);
    Object.values(node.provenanceParentNodeIds).forEach(includePriorAncestry);
  };
  for (const node of [...selectedNodes.values()]) {
    for (const parentNodeId of Object.values(node.provenanceParentNodeIds)) {
      if (!outputNodes.has(parentNodeId)) includePriorAncestry(parentNodeId);
    }
  }
  const nodes = [...outputNodes.values()].sort((left, right) =>
    left.nodeId.localeCompare(right.nodeId),
  );
  validateTrackedEvidenceReusePaths(nodes, currentRefs);
  return {
    nodes,
    currentRefs: Object.fromEntries(
      Object.entries(currentRefs).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
    reusedDescendantNodeIds: [...reusedDescendantIds].sort(),
    convergenceNodeIds: [...convergenceNodes.keys()].sort(),
    reuseProofNodeIds: [...proofNodes.keys()].sort(),
  };
}

export function resolveTrackedEvidenceCurrentParents(
  nodes: readonly EvidenceNode[],
  currentRefs: Readonly<Record<string, string>>,
  descendant: EvidenceNode,
): Record<string, EvidenceNode> {
  validateTrackedEvidenceReusePaths(nodes, currentRefs);
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const resolved: Record<string, EvidenceNode> = {};
  for (const [role, nodeId] of Object.entries(
    descendant.provenanceParentNodeIds,
  )) {
    const parent = byId.get(nodeId);
    if (!parent) throw reusePathInvalid();
    resolved[role] = parent;
  }
  for (const [refName, newParentNodeId] of Object.entries(currentRefs)) {
    const match = CURRENT_PARENT_REF.exec(refName);
    if (!match || match[1] !== descendant.nodeId) continue;
    const proofRef = `reuse-proof/${match[1]}/${match[2]}`;
    const proof = byId.get(currentRefs[proofRef]!);
    const binding = proof ? readReuseProofBinding(proof) : null;
    const parent = byId.get(newParentNodeId);
    if (!binding || !parent) throw reusePathInvalid();
    resolved[binding.parentRole] = parent;
  }
  return resolved;
}

function isReusePathNode(node: EvidenceNode): boolean {
  return (
    node.type === 'evidence-convergence' || node.type === 'evidence-reuse-proof'
  );
}

function reachableCurrentOrdinaryNodeIds(
  nodes: readonly EvidenceNode[],
  currentRefs: Readonly<Record<string, string>>,
): Set<string> {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const reachable = new Set<string>();
  const add = (rootId: string): void => {
    const pending = [rootId];
    while (pending.length > 0) {
      const nodeId = pending.pop()!;
      if (reachable.has(nodeId)) continue;
      const node = byId.get(nodeId);
      if (!node || isReusePathNode(node)) throw reusePathInvalid();
      reachable.add(nodeId);
      pending.push(...Object.values(node.provenanceParentNodeIds));
    }
  };
  for (const [name, nodeId] of Object.entries(currentRefs)) {
    if (
      !name.startsWith('current-parent/') &&
      !name.startsWith('reuse-proof/')
    ) {
      add(nodeId);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, nodeId] of Object.entries(currentRefs)) {
      const match = CURRENT_PARENT_REF.exec(name);
      if (match && reachable.has(match[1]) && !reachable.has(nodeId)) {
        add(nodeId);
        changed = true;
      }
    }
  }
  return reachable;
}

function reusableNodeKey(node: EvidenceNode): string {
  return canonicalJson({
    type: node.type,
    nodeSchema: node.nodeSchema,
    evaluator: node.evaluator,
    policyDigest: node.policyDigest,
    exactInputDigests: node.exactInputDigests,
    semanticParentResultDigests: node.semanticParentResultDigests,
    outputSchema: node.outputSchema,
    output: node.output,
  });
}

function assertDigest(value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw reusePathInvalid();
}

function reusePathInvalid() {
  return workflowError(
    'EVIDENCE_REUSE_PATH_INVALID',
    'Tracked descendant reuse path is malformed or incomplete.',
    ExitCode.verification,
  );
}
