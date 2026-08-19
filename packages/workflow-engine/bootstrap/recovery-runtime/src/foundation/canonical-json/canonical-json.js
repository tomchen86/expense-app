import { ExitCode, workflowError } from '../errors/errors.js';
/**
 * Serialize a value to a canonical JSON string: object keys are sorted
 * recursively, array order is preserved, and anything that is not true finite
 * JSON data is rejected. Only null, strings, booleans, finite numbers, dense
 * arrays, and plain string-keyed objects are accepted. Non-plain objects (for
 * example Date), sparse array holes, and cyclic references all raise
 * CANONICAL_JSON_INVALID instead of being coerced or overflowing the stack.
 */
export function canonicalJson(value) {
    return serialize(value, new Set());
}
/**
 * Compare strings by ECMAScript UTF-16 code units. Unlike locale-aware
 * collation, this order is invariant across hosts and is the same order used
 * by an argument-less Array.prototype.sort().
 */
export function compareCanonicalStrings(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
function serialize(value, ancestors) {
    if (value === null) {
        return 'null';
    }
    switch (typeof value) {
        case 'string':
            return JSON.stringify(value);
        case 'boolean':
            return value ? 'true' : 'false';
        case 'number':
            if (!Number.isFinite(value)) {
                throw invalidCanonicalJson();
            }
            return JSON.stringify(value);
        case 'object': {
            const container = value;
            if (ancestors.has(container)) {
                throw invalidCanonicalJson();
            }
            ancestors.add(container);
            try {
                return Array.isArray(container)
                    ? serializeArray(container, ancestors)
                    : serializeObject(container, ancestors);
            }
            finally {
                ancestors.delete(container);
            }
        }
        default:
            // undefined, function, symbol, bigint are not JSON data.
            throw invalidCanonicalJson();
    }
}
function serializeArray(value, ancestors) {
    const parts = [];
    for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
            // A sparse hole is not JSON data.
            throw invalidCanonicalJson();
        }
        parts.push(serialize(value[index], ancestors));
    }
    return `[${parts.join(',')}]`;
}
function serializeObject(value, ancestors) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        // Only plain string-keyed objects are canonical JSON data.
        throw invalidCanonicalJson();
    }
    const record = value;
    const parts = Object.keys(record)
        .sort(compareCanonicalStrings)
        .map((key) => `${JSON.stringify(key)}:${serialize(record[key], ancestors)}`);
    return `{${parts.join(',')}}`;
}
function invalidCanonicalJson() {
    return workflowError('CANONICAL_JSON_INVALID', 'Value cannot be encoded as canonical JSON data.', ExitCode.usage);
}
