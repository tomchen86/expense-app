/** Error raised when a value cannot own deterministic canonical JSON bytes. */
export class CanonicalJsonError extends TypeError {
  readonly code = 'CANONICAL_JSON_INVALID';

  constructor() {
    super('Value cannot be encoded as canonical JSON data.');
    this.name = 'CanonicalJsonError';
  }
}

export function canonicalJson(value: unknown): string {
  return serialize(value, new Set());
}

export function compareCanonicalStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function serialize(value: unknown, ancestors: Set<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalJsonError();
      return JSON.stringify(value);
    case 'object': {
      const container = value as object;
      if (ancestors.has(container)) throw new CanonicalJsonError();
      ancestors.add(container);
      try {
        return Array.isArray(container)
          ? serializeArray(container, ancestors)
          : serializeObject(container, ancestors);
      } finally {
        ancestors.delete(container);
      }
    }
    default:
      throw new CanonicalJsonError();
  }
}

function serializeArray(value: unknown[], ancestors: Set<object>): string {
  const parts: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      throw new CanonicalJsonError();
    }
    parts.push(serialize(value[index], ancestors));
  }
  return `[${parts.join(',')}]`;
}

function serializeObject(value: object, ancestors: Set<object>): string {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CanonicalJsonError();
  }
  const record = value as Record<string, unknown>;
  const parts = Object.keys(record)
    .sort(compareCanonicalStrings)
    .map(
      (key) => `${JSON.stringify(key)}:${serialize(record[key], ancestors)}`,
    );
  return `{${parts.join(',')}}`;
}
