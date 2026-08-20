import {
  CanonicalJsonError,
  canonicalJson as encodeCanonicalJson,
  compareCanonicalStrings as compareCoreCanonicalStrings,
} from '@jigwright/core/canonical-json';

import { ExitCode, workflowError } from '../errors/errors.ts';

/**
 * Serialize a value to a canonical JSON string: object keys are sorted
 * recursively, array order is preserved, and anything that is not true finite
 * JSON data is rejected. Only null, strings, booleans, finite numbers, dense
 * arrays, and plain string-keyed objects are accepted. Non-plain objects (for
 * example Date), sparse array holes, and cyclic references all raise
 * CANONICAL_JSON_INVALID instead of being coerced or overflowing the stack.
 */
export function canonicalJson(value: unknown): string {
  try {
    return encodeCanonicalJson(value);
  } catch (error) {
    if (error instanceof CanonicalJsonError) throw invalidCanonicalJson();
    throw error;
  }
}

/**
 * Compare strings by ECMAScript UTF-16 code units. Unlike locale-aware
 * collation, this order is invariant across hosts and is the same order used
 * by an argument-less Array.prototype.sort().
 */
export function compareCanonicalStrings(left: string, right: string): number {
  return compareCoreCanonicalStrings(left, right);
}

function invalidCanonicalJson() {
  return workflowError(
    'CANONICAL_JSON_INVALID',
    'Value cannot be encoded as canonical JSON data.',
    ExitCode.usage,
  );
}
