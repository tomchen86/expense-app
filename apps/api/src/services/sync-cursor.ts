const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATABASE_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/;

export type SyncCursor = {
  updatedAt: string;
  id: string;
};

const isCursor = (value: unknown): value is SyncCursor => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<SyncCursor>;
  return (
    typeof candidate.updatedAt === 'string' &&
    DATABASE_TIMESTAMP_PATTERN.test(candidate.updatedAt) &&
    Number.isFinite(Date.parse(candidate.updatedAt)) &&
    typeof candidate.id === 'string' &&
    UUID_PATTERN.test(candidate.id)
  );
};

export const encodeSyncCursor = (cursor: SyncCursor): string => {
  if (!isCursor(cursor)) {
    throw new Error('Invalid sync cursor');
  }
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
};

export const decodeSyncCursor = (encoded: string): SyncCursor => {
  try {
    if (!encoded) {
      throw new Error('empty');
    }
    const parsed: unknown = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8'),
    );
    if (!isCursor(parsed)) {
      throw new Error('shape');
    }
    return parsed;
  } catch {
    throw new Error('Invalid sync cursor');
  }
};
