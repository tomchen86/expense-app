import crypto from 'node:crypto';
import { ExitCode, workflowError } from './foundation/errors/errors.js';
import { assertStoredEvidenceNode, createEvidenceNode, } from './evidence-node.js';
/**
 * Convergence and descendant-reuse records are themselves canonical
 * `EvidenceNode` envelopes. A convergence record attests that a provenance
 * parent whose `nodeId` changed still carries an identical, compatible result,
 * so a specific descendant edge may reuse it. A descendant-reuse proof binds one
 * such convergence to one `(descendant, parentRole)` edge. Both are immutable and
 * carry every binding needed to re-validate them without ambient state.
 */
const CONVERGENCE_TYPE = 'evidence-convergence';
const CONVERGENCE_NODE_SCHEMA = 'expense-app.workflow.evidence-convergence.v1';
const CONVERGENCE_OUTPUT_SCHEMA = 'expense-app.workflow.evidence-convergence-output.v1';
const REUSE_PROOF_TYPE = 'evidence-reuse-proof';
const REUSE_PROOF_NODE_SCHEMA = 'expense-app.workflow.evidence-reuse-proof.v1';
const REUSE_PROOF_OUTPUT_SCHEMA = 'expense-app.workflow.evidence-reuse-proof-output.v1';
const CONVERGENCE_EXACT_ROLES = ['newParentNode', 'oldParentNode'];
const CONVERGENCE_PROVENANCE_ROLES = ['newParent', 'oldParent'];
const CONVERGENCE_OUTPUT_KEYS = [
    'sharedEvaluator',
    'sharedNodeSchema',
    'sharedOutputSchema',
    'sharedPolicyDigest',
    'sharedResultDigest',
    'sharedType',
    'validatorVersion',
];
const REUSE_PROOF_EXACT_ROLES = [
    'convergenceNode',
    'descendantNode',
    'newParentNode',
    'oldParentNode',
    'parentRole',
];
const REUSE_PROOF_PROVENANCE_ROLES = [
    'convergence',
    'descendant',
    'newParent',
    'oldParent',
];
const REUSE_PROOF_OUTPUT_KEYS = [
    'parentRole',
    'sharedResultDigest',
    'validatorVersion',
];
/**
 * Two parents are compatible when every identity field participating in reuse
 * is equal: node type, evaluator, policy digest, node schema, output schema, and
 * result digest. Equal bytes under an incompatible identity are not compatible.
 */
export function parentsCompatible(a, b) {
    return (a.type === b.type &&
        a.evaluator === b.evaluator &&
        a.policyDigest === b.policyDigest &&
        a.nodeSchema === b.nodeSchema &&
        a.outputSchema === b.outputSchema &&
        a.resultDigest === b.resultDigest);
}
/**
 * Build a convergence record for two parents that share the same result under a
 * compatible identity.
 */
export function createConvergenceRecord(input) {
    const oldParent = assertStoredEvidenceNode(input.oldParent, convergenceInvalid);
    const newParent = assertStoredEvidenceNode(input.newParent, convergenceInvalid);
    if (!parentsCompatible(oldParent, newParent)) {
        throw convergenceIncompatible();
    }
    return createEvidenceNode({
        type: CONVERGENCE_TYPE,
        nodeSchema: CONVERGENCE_NODE_SCHEMA,
        evaluator: input.validatorVersion,
        policyDigest: oldParent.policyDigest,
        exactInputDigests: {
            oldParentNode: oldParent.nodeId,
            newParentNode: newParent.nodeId,
        },
        semanticParentResultDigests: {
            shared: oldParent.resultDigest,
        },
        provenanceParentNodeIds: {
            oldParent: oldParent.nodeId,
            newParent: newParent.nodeId,
        },
        outputSchema: CONVERGENCE_OUTPUT_SCHEMA,
        output: {
            sharedResultDigest: oldParent.resultDigest,
            sharedType: oldParent.type,
            sharedEvaluator: oldParent.evaluator,
            sharedPolicyDigest: oldParent.policyDigest,
            sharedNodeSchema: oldParent.nodeSchema,
            sharedOutputSchema: oldParent.outputSchema,
            validatorVersion: input.validatorVersion,
        },
        runtimeMetadata: input.runtimeMetadata,
    });
}
/**
 * Build a descendant-reuse proof binding one convergence record to one
 * `(descendant, parentRole)` edge. Beyond a well-formed convergence, the builder
 * independently requires the old/new parents to be compatible and every
 * convergence compatibility claim to match the resolved parents, and the
 * descendant to cite the old parent under that role by both provenance id and
 * semantic result.
 */
export function createDescendantReuseProof(input) {
    const descendant = assertStoredEvidenceNode(input.descendant, reuseProofInvalid);
    const oldParent = assertStoredEvidenceNode(input.oldParent, reuseProofInvalid);
    const newParent = assertStoredEvidenceNode(input.newParent, reuseProofInvalid);
    const convergence = assertStoredEvidenceNode(input.convergenceRecord, reuseProofInvalid);
    const binding = readConvergenceBinding(convergence);
    if (!binding ||
        !parentsCompatible(oldParent, newParent) ||
        binding.validatorVersion !== input.validatorVersion ||
        binding.oldParentNode !== oldParent.nodeId ||
        binding.newParentNode !== newParent.nodeId ||
        binding.sharedType !== oldParent.type ||
        binding.sharedEvaluator !== oldParent.evaluator ||
        binding.sharedPolicyDigest !== oldParent.policyDigest ||
        binding.sharedNodeSchema !== oldParent.nodeSchema ||
        binding.sharedOutputSchema !== oldParent.outputSchema ||
        binding.sharedResultDigest !== oldParent.resultDigest ||
        binding.sharedResultDigest !== newParent.resultDigest ||
        descendant.provenanceParentNodeIds[input.parentRole] !== oldParent.nodeId ||
        descendant.semanticParentResultDigests[input.parentRole] !==
            oldParent.resultDigest) {
        throw reuseProofInvalid();
    }
    return createEvidenceNode({
        type: REUSE_PROOF_TYPE,
        nodeSchema: REUSE_PROOF_NODE_SCHEMA,
        evaluator: input.validatorVersion,
        policyDigest: descendant.policyDigest,
        exactInputDigests: {
            descendantNode: descendant.nodeId,
            oldParentNode: oldParent.nodeId,
            newParentNode: newParent.nodeId,
            convergenceNode: convergence.nodeId,
            parentRole: digestParentRole(input.parentRole),
        },
        semanticParentResultDigests: {
            shared: oldParent.resultDigest,
        },
        provenanceParentNodeIds: {
            descendant: descendant.nodeId,
            oldParent: oldParent.nodeId,
            newParent: newParent.nodeId,
            convergence: convergence.nodeId,
        },
        outputSchema: REUSE_PROOF_OUTPUT_SCHEMA,
        output: {
            parentRole: input.parentRole,
            sharedResultDigest: oldParent.resultDigest,
            validatorVersion: input.validatorVersion,
        },
        runtimeMetadata: input.runtimeMetadata,
    });
}
/**
 * Read the edge binding from a convergence envelope, or `null` when the node is
 * not a well-formed, internally consistent convergence record. Every exposed
 * compatibility claim must be a nonempty string, digests where applicable, and
 * the envelope policy must bind the claimed shared policy.
 */
export function readConvergenceBinding(node) {
    if (node.type !== CONVERGENCE_TYPE ||
        node.nodeSchema !== CONVERGENCE_NODE_SCHEMA ||
        node.outputSchema !== CONVERGENCE_OUTPUT_SCHEMA ||
        !hasExactKeys(node.exactInputDigests, CONVERGENCE_EXACT_ROLES) ||
        !hasExactKeys(node.provenanceParentNodeIds, CONVERGENCE_PROVENANCE_ROLES) ||
        !hasExactKeys(node.semanticParentResultDigests, ['shared'])) {
        return null;
    }
    const oldParentNode = node.exactInputDigests.oldParentNode;
    const newParentNode = node.exactInputDigests.newParentNode;
    if (node.provenanceParentNodeIds.oldParent !== oldParentNode ||
        node.provenanceParentNodeIds.newParent !== newParentNode) {
        return null;
    }
    const output = node.output;
    if (!isRecord(output) || !hasExactKeys(output, CONVERGENCE_OUTPUT_KEYS)) {
        return null;
    }
    const sharedType = output.sharedType;
    const sharedEvaluator = output.sharedEvaluator;
    const sharedPolicyDigest = output.sharedPolicyDigest;
    const sharedNodeSchema = output.sharedNodeSchema;
    const sharedOutputSchema = output.sharedOutputSchema;
    const sharedResultDigest = output.sharedResultDigest;
    const validatorVersion = output.validatorVersion;
    if (!isNonEmptyString(sharedType) ||
        !isNonEmptyString(sharedEvaluator) ||
        !isNonEmptyString(sharedPolicyDigest) ||
        !isNonEmptyString(sharedNodeSchema) ||
        !isNonEmptyString(sharedOutputSchema) ||
        !isNonEmptyString(sharedResultDigest) ||
        !isNonEmptyString(validatorVersion) ||
        validatorVersion !== node.evaluator ||
        sharedResultDigest !== node.semanticParentResultDigests.shared ||
        sharedPolicyDigest !== node.policyDigest) {
        return null;
    }
    return {
        oldParentNode,
        newParentNode,
        sharedType,
        sharedEvaluator,
        sharedPolicyDigest,
        sharedNodeSchema,
        sharedOutputSchema,
        sharedResultDigest,
        validatorVersion,
    };
}
/**
 * Read the edge binding from a descendant-reuse proof envelope, or `null` when
 * the node is not a well-formed, internally consistent reuse proof.
 */
export function readReuseProofBinding(node) {
    if (node.type !== REUSE_PROOF_TYPE ||
        node.nodeSchema !== REUSE_PROOF_NODE_SCHEMA ||
        node.outputSchema !== REUSE_PROOF_OUTPUT_SCHEMA ||
        !hasExactKeys(node.exactInputDigests, REUSE_PROOF_EXACT_ROLES) ||
        !hasExactKeys(node.provenanceParentNodeIds, REUSE_PROOF_PROVENANCE_ROLES) ||
        !hasExactKeys(node.semanticParentResultDigests, ['shared'])) {
        return null;
    }
    const descendantNode = node.exactInputDigests.descendantNode;
    const oldParentNode = node.exactInputDigests.oldParentNode;
    const newParentNode = node.exactInputDigests.newParentNode;
    const convergenceNode = node.exactInputDigests.convergenceNode;
    const parentRoleDigest = node.exactInputDigests.parentRole;
    if (node.provenanceParentNodeIds.descendant !== descendantNode ||
        node.provenanceParentNodeIds.oldParent !== oldParentNode ||
        node.provenanceParentNodeIds.newParent !== newParentNode ||
        node.provenanceParentNodeIds.convergence !== convergenceNode) {
        return null;
    }
    const output = node.output;
    if (!isRecord(output) || !hasExactKeys(output, REUSE_PROOF_OUTPUT_KEYS)) {
        return null;
    }
    const parentRole = output.parentRole;
    const sharedResultDigest = output.sharedResultDigest;
    const validatorVersion = output.validatorVersion;
    if (!isNonEmptyString(parentRole) ||
        !isNonEmptyString(sharedResultDigest) ||
        !isNonEmptyString(validatorVersion) ||
        parentRoleDigest !== digestParentRole(parentRole) ||
        validatorVersion !== node.evaluator ||
        sharedResultDigest !== node.semanticParentResultDigests.shared) {
        return null;
    }
    return {
        descendantNode,
        oldParentNode,
        newParentNode,
        convergenceNode,
        parentRole,
        sharedResultDigest,
        validatorVersion,
    };
}
function digestParentRole(parentRole) {
    return crypto.createHash('sha256').update(parentRole, 'utf8').digest('hex');
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isNonEmptyString(value) {
    return typeof value === 'string' && value.length > 0;
}
function hasExactKeys(value, keys) {
    const own = Object.keys(value);
    return (own.length === keys.length &&
        keys.every((key) => Object.prototype.hasOwnProperty.call(value, key)));
}
function convergenceIncompatible() {
    return workflowError('EVIDENCE_CONVERGENCE_INCOMPATIBLE', 'Convergence requires equal type, evaluator, policy, schemas, and result.', ExitCode.usage);
}
function convergenceInvalid() {
    return workflowError('EVIDENCE_CONVERGENCE_INVALID', 'Convergence record input is malformed.', ExitCode.usage);
}
function reuseProofInvalid() {
    return workflowError('EVIDENCE_REUSE_PROOF_INVALID', 'Descendant reuse proof input is malformed.', ExitCode.usage);
}
