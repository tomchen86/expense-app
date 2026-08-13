import { decodeSyncCursor, encodeSyncCursor } from '../../services/sync-cursor';

describe('sync cursor', () => {
  it('round-trips the stable updatedAt and id tuple', () => {
    const cursor = encodeSyncCursor({
      updatedAt: '2026-08-13T01:02:03.456Z',
      id: '11111111-1111-4111-8111-111111111111',
    });

    expect(decodeSyncCursor(cursor)).toEqual({
      updatedAt: '2026-08-13T01:02:03.456Z',
      id: '11111111-1111-4111-8111-111111111111',
    });
  });

  it('preserves PostgreSQL microsecond precision without narrowing to Date', () => {
    const cursor = encodeSyncCursor({
      updatedAt: '2026-08-13 01:02:03.456789+00',
      id: '11111111-1111-4111-8111-111111111111',
    });

    expect(decodeSyncCursor(cursor).updatedAt).toBe(
      '2026-08-13 01:02:03.456789+00',
    );
  });

  it.each(['', 'not-base64', Buffer.from('{}').toString('base64url')])(
    'rejects malformed cursor %p',
    (cursor) => {
      expect(() => decodeSyncCursor(cursor)).toThrow('Invalid sync cursor');
    },
  );
});
