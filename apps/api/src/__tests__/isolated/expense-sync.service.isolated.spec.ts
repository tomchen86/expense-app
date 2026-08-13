import { ExpenseSyncService } from '../../services/expense-sync.service';
import { encodeSyncCursor } from '../../services/sync-cursor';

const queryBuilder = () => ({
  withDeleted: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  andWhere: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
  addOrderBy: jest.fn().mockReturnThis(),
  addSelect: jest.fn().mockReturnThis(),
  take: jest.fn().mockReturnThis(),
  getRawAndEntities: jest.fn(),
});

describe('ExpenseSyncService', () => {
  const qb = queryBuilder();
  const expenseRepository = {
    manager: { connection: { options: { type: 'postgres' } } },
    createQueryBuilder: jest.fn(() => qb),
  };
  const splitRepository = { find: jest.fn() };
  const ledgerService = { resolveSpaceForUser: jest.fn() };
  const service = new ExpenseSyncService(
    expenseRepository as never,
    splitRepository as never,
    ledgerService as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    expenseRepository.manager.connection.options.type = 'postgres';
    expenseRepository.createQueryBuilder.mockReturnValue(qb);
    ledgerService.resolveSpaceForUser.mockResolvedValue({
      spaceId: 'space-1',
      coupleId: 'space-1',
      kind: 'shared',
    });
    splitRepository.find.mockResolvedValue([]);
  });

  it('returns versioned tombstones and a stable next cursor', async () => {
    qb.getRawAndEntities.mockResolvedValue({
      entities: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          clientMutationId: 'mutation-1',
          coupleId: 'space-1',
          version: 3,
          updatedAt: new Date('2026-08-13T01:02:03.456Z'),
          deletedAt: new Date('2026-08-13T01:02:03.000Z'),
        },
      ],
      raw: [
        {
          sync_updated_at: '2026-08-13 01:02:03.456789+00',
        },
      ],
    });

    const page = await service.listChanges('user-1', 'space-1', undefined, 10);

    expect(page.changes).toEqual([
      expect.objectContaining({
        id: '11111111-1111-4111-8111-111111111111',
        spaceId: 'space-1',
        version: 3,
        expense: null,
        deletedAt: '2026-08-13T01:02:03.000Z',
      }),
    ]);
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(qb.addSelect).toHaveBeenCalledWith(
      expect.stringContaining('to_char'),
      'sync_updated_at',
    );
    expect(
      JSON.parse(Buffer.from(page.nextCursor!, 'base64url').toString('utf8'))
        .updatedAt,
    ).toBe('2026-08-13 01:02:03.456789+00');
    expect(page.hasMore).toBe(false);
    expect(splitRepository.find).not.toHaveBeenCalled();
  });

  it('requests one extra row to report hasMore without leaking it', async () => {
    const rows = [1, 2].map((version) => ({
      id:
        version === 1
          ? '11111111-1111-4111-8111-111111111111'
          : '22222222-2222-4222-8222-222222222222',
      clientMutationId: `mutation-${version}`,
      coupleId: 'space-1',
      version,
      updatedAt: new Date(`2026-08-13T01:02:0${version}.000Z`),
      deletedAt: new Date(`2026-08-13T01:02:0${version}.000Z`),
    }));
    qb.getRawAndEntities.mockResolvedValue({
      entities: rows,
      raw: rows.map((row) => ({
        sync_updated_at: row.updatedAt.toISOString(),
      })),
    });

    const page = await service.listChanges('user-1', 'space-1', undefined, 1);

    expect(qb.take).toHaveBeenCalledWith(2);
    expect(page.changes).toHaveLength(1);
    expect(page.hasMore).toBe(true);
  });

  it('keeps the acknowledged cursor when no later changes exist', async () => {
    const after = encodeSyncCursor({
      updatedAt: '2026-08-13 01:02:03.456789+00',
      id: '11111111-1111-4111-8111-111111111111',
    });
    qb.getRawAndEntities.mockResolvedValue({ entities: [], raw: [] });

    const page = await service.listChanges('user-1', 'space-1', after, 10);

    expect(page).toMatchObject({
      changes: [],
      nextCursor: after,
      hasMore: false,
    });
  });

  it('normalizes SQL.js timestamps into a timezone-qualified cursor value', async () => {
    expenseRepository.manager.connection.options.type = 'sqljs';
    qb.getRawAndEntities.mockResolvedValue({ entities: [], raw: [] });

    await service.listChanges('user-1', 'space-1', undefined, 10);

    expect(qb.addSelect).toHaveBeenCalledWith(
      expect.stringContaining('strftime'),
      'sync_updated_at',
    );
  });
});
