/**
 * Bootstrap-local canonical JSON. This module intentionally has no dependency
 * on the swappable workflow engine under src/**.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, new Set());
}

function serialize(value: unknown, ancestors: Set<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (Number.isFinite(value)) return JSON.stringify(value);
      break;
    case 'object': {
      const container = value as object;
      if (ancestors.has(container)) break;
      ancestors.add(container);
      try {
        if (Array.isArray(container)) {
          const parts: string[] = [];
          for (let index = 0; index < container.length; index += 1) {
            if (!Object.prototype.hasOwnProperty.call(container, index)) {
              throw new TypeError('Value is not canonical JSON data.');
            }
            parts.push(serialize(container[index], ancestors));
          }
          return `[${parts.join(',')}]`;
        }
        const prototype = Object.getPrototypeOf(container);
        if (prototype !== Object.prototype && prototype !== null) break;
        const record = container as Record<string, unknown>;
        return `{${Object.keys(record)
          .sort()
          .map(
            (key) =>
              `${JSON.stringify(key)}:${serialize(record[key], ancestors)}`,
          )
          .join(',')}}`;
      } finally {
        ancestors.delete(container);
      }
    }
  }
  throw new TypeError('Value is not canonical JSON data.');
}
