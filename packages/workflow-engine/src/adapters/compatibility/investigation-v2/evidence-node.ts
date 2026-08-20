import { CanonicalJsonError } from '@jigwright/core/canonical-json';
import {
  assertStoredEvidenceNode as assertCoreStoredEvidenceNode,
  canonicalEvidenceNodeEnvelope as canonicalCoreEvidenceNodeEnvelope,
  createEvidenceNode as createCoreEvidenceNode,
  type EvidenceNode,
  type EvidenceNodeInput,
} from '@jigwright/core/evidence-node';

import {
  ExitCode,
  workflowError,
  type WorkflowError,
} from '../../../foundation/errors/errors.ts';

export type { EvidenceNode, EvidenceNodeInput };

/**
 * Stable workflow compatibility facade for the mechanically extracted neutral
 * evidence envelope codec. WorkflowError remains local to this package.
 */
export function createEvidenceNode(input: EvidenceNodeInput): EvidenceNode {
  return createCoreEvidenceNode(input, nodeInvalid);
}

export function canonicalEvidenceNodeEnvelope(node: EvidenceNode): string {
  try {
    return canonicalCoreEvidenceNodeEnvelope(node);
  } catch (error) {
    if (error instanceof CanonicalJsonError) {
      throw workflowError(
        'CANONICAL_JSON_INVALID',
        'Value cannot be encoded as canonical JSON data.',
        ExitCode.usage,
      );
    }
    throw error;
  }
}

export function assertStoredEvidenceNode(
  value: unknown,
  invalid: () => WorkflowError,
): EvidenceNode {
  return assertCoreStoredEvidenceNode(value, invalid);
}

function nodeInvalid(): WorkflowError {
  return workflowError(
    'EVIDENCE_NODE_INVALID',
    'Evidence node input is malformed.',
    ExitCode.usage,
  );
}
