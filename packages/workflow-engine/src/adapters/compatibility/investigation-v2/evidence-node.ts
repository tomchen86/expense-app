import crypto from 'node:crypto';

import { canonicalJson } from '../../../foundation/canonical-json/canonical-json.ts';
import {
  ExitCode,
  workflowError,
  type WorkflowError,
} from '../../../foundation/errors/errors.ts';

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const DIGEST_ROLE_PATTERN = /^[a-zA-Z0-9]+(?:[._:/-][a-zA-Z0-9]+)*$/;

const EVIDENCE_NODE_KEYS = [
  'nodeSchema',
  'nodeId',
  'type',
  'evaluator',
  'policyDigest',
  'exactInputDigests',
  'semanticParentResultDigests',
  'provenanceParentNodeIds',
  'outputSchema',
  'output',
  'resultDigest',
  'runtimeMetadata',
] as const;

/**
 * Author-supplied description of an evidence node. Runtime metadata is carried
 * through into the immutable envelope but never participates in either digest.
 */
export type EvidenceNodeInput = {
  type: string;
  nodeSchema: string;
  evaluator: string;
  policyDigest: string;
  exactInputDigests: Record<string, string>;
  semanticParentResultDigests: Record<string, string>;
  provenanceParentNodeIds: Record<string, string>;
  outputSchema: string;
  output: unknown;
  runtimeMetadata: Record<string, unknown>;
};

/**
 * Immutable evidence envelope. `nodeId` binds exact inputs and provenance;
 * `resultDigest` binds the semantic output; `runtimeMetadata` is observable but
 * excluded from both digests.
 */
export type EvidenceNode = {
  nodeSchema: string;
  nodeId: string;
  type: string;
  evaluator: string;
  policyDigest: string;
  exactInputDigests: Record<string, string>;
  semanticParentResultDigests: Record<string, string>;
  provenanceParentNodeIds: Record<string, string>;
  outputSchema: string;
  output: unknown;
  resultDigest: string;
  runtimeMetadata: Record<string, unknown>;
};

export function createEvidenceNode(input: EvidenceNodeInput): EvidenceNode {
  if (
    !isLabel(input.type) ||
    !isLabel(input.nodeSchema) ||
    !isLabel(input.evaluator) ||
    !isLabel(input.outputSchema) ||
    !isDigest(input.policyDigest) ||
    !isDigestMap(input.exactInputDigests) ||
    !isDigestMap(input.semanticParentResultDigests) ||
    !isDigestMap(input.provenanceParentNodeIds) ||
    !isPlainRecord(input.runtimeMetadata)
  ) {
    throw nodeInvalid();
  }

  let snapshot: {
    exactInputDigests: Record<string, string>;
    semanticParentResultDigests: Record<string, string>;
    provenanceParentNodeIds: Record<string, string>;
    output: unknown;
    runtimeMetadata: Record<string, unknown>;
  };
  try {
    // Canonicalization proves the data is finite JSON before we snapshot it so
    // later caller mutation of the source objects cannot alter the envelope.
    canonicalJson(input.output);
    canonicalJson(input.runtimeMetadata);
    snapshot = {
      exactInputDigests: structuredClone(input.exactInputDigests),
      semanticParentResultDigests: structuredClone(
        input.semanticParentResultDigests,
      ),
      provenanceParentNodeIds: structuredClone(input.provenanceParentNodeIds),
      output: structuredClone(input.output),
      runtimeMetadata: structuredClone(input.runtimeMetadata),
    };
  } catch {
    throw nodeInvalid();
  }

  const node: EvidenceNode = {
    nodeSchema: input.nodeSchema,
    nodeId: '',
    type: input.type,
    evaluator: input.evaluator,
    policyDigest: input.policyDigest,
    exactInputDigests: snapshot.exactInputDigests,
    semanticParentResultDigests: snapshot.semanticParentResultDigests,
    provenanceParentNodeIds: snapshot.provenanceParentNodeIds,
    outputSchema: input.outputSchema,
    output: snapshot.output,
    resultDigest: '',
    runtimeMetadata: snapshot.runtimeMetadata,
  };
  const { nodeId, resultDigest } = computeEvidenceDigests(node);
  node.nodeId = nodeId;
  node.resultDigest = resultDigest;
  return node;
}

export function canonicalEvidenceNodeEnvelope(node: EvidenceNode): string {
  return canonicalJson(node);
}

/**
 * Validate a parsed evidence envelope: exact shape, well-formed digest fields,
 * canonical output/metadata, and both recomputed digests. Returns the typed
 * node or throws the caller-supplied error.
 */
export function assertStoredEvidenceNode(
  value: unknown,
  invalid: () => WorkflowError,
): EvidenceNode {
  if (!isPlainRecord(value) || !hasExactKeys(value, EVIDENCE_NODE_KEYS)) {
    throw invalid();
  }
  if (
    !isLabel(value.nodeSchema) ||
    !isDigest(value.nodeId) ||
    !isLabel(value.type) ||
    !isLabel(value.evaluator) ||
    !isDigest(value.policyDigest) ||
    !isDigestMap(value.exactInputDigests) ||
    !isDigestMap(value.semanticParentResultDigests) ||
    !isDigestMap(value.provenanceParentNodeIds) ||
    !isLabel(value.outputSchema) ||
    !isDigest(value.resultDigest) ||
    !isPlainRecord(value.runtimeMetadata)
  ) {
    throw invalid();
  }

  const node = value as unknown as EvidenceNode;
  let digests: { nodeId: string; resultDigest: string };
  try {
    canonicalJson(node.output);
    canonicalJson(node.runtimeMetadata);
    digests = computeEvidenceDigests(node);
  } catch {
    throw invalid();
  }
  if (
    digests.nodeId !== node.nodeId ||
    digests.resultDigest !== node.resultDigest
  ) {
    throw invalid();
  }
  return node;
}

function computeEvidenceDigests(node: EvidenceNode): {
  nodeId: string;
  resultDigest: string;
} {
  const nodeId = sha256(
    canonicalJson({
      type: node.type,
      nodeSchema: node.nodeSchema,
      evaluator: node.evaluator,
      policyDigest: node.policyDigest,
      exactInputDigests: node.exactInputDigests,
      semanticParentResultDigests: node.semanticParentResultDigests,
      provenanceParentNodeIds: node.provenanceParentNodeIds,
    }),
  );
  const resultDigest = sha256(
    canonicalJson({
      type: node.type,
      outputSchema: node.outputSchema,
      output: node.output,
    }),
  );
  return { nodeId, resultDigest };
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function isLabel(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST_PATTERN.test(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isDigestMap(value: unknown): value is Record<string, string> {
  return (
    isPlainRecord(value) &&
    Object.entries(value).every(
      ([role, digest]) => DIGEST_ROLE_PATTERN.test(role) && isDigest(digest),
    )
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const own = Object.keys(value);
  return (
    own.length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function nodeInvalid() {
  return workflowError(
    'EVIDENCE_NODE_INVALID',
    'Evidence node input is malformed.',
    ExitCode.usage,
  );
}
