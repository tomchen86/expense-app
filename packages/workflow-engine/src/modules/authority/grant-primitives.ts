import crypto from 'node:crypto';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';

export const GRANT_STABLE_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
export const GRANT_SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
export const GRANT_UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const GRANT_SESSION_NONCE = /^[A-Za-z0-9._:-]{16,256}$/;

export function grantSha256(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

export function grantHasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return grantSameStrings(Object.keys(value), keys);
}

export function grantHasAllowedKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    required.every((key) => actual.includes(key)) &&
    actual.every((key) => required.includes(key) || optional.includes(key))
  );
}

export function grantSameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const normalizedLeft = [...left].sort();
  const normalizedRight = [...right].sort();
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index])
  );
}

export function freezeGrantCanonical<T>(value: T): T {
  return deepFreezeGrant(JSON.parse(canonicalJson(value)) as T);
}

export function deepFreezeGrant<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreezeGrant(nested);
  }
  return value;
}

export function parseGrantTimestamp(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
    ? parsed
    : null;
}

export function copyGrantDate(value: unknown): Date | null {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    return null;
  return new Date(value);
}
