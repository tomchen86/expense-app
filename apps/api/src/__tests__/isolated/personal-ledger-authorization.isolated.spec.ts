import { PersonalLedgerService } from '../../services/personal-ledger.service';

describe('PersonalLedgerService personal-space ownership', () => {
  it("does not query another creator's personal space from a legacy membership", async () => {
    const expenseQuery = {
      leftJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      distinct: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn(async () => []),
    };
    const service = new PersonalLedgerService(
      {
        find: jest.fn(async () => [
          { id: 'personal-own', kind: 'personal', createdBy: 'user-1' },
          { id: 'personal-foreign', kind: 'personal', createdBy: 'user-2' },
          { id: 'shared-1', kind: 'shared', createdBy: 'user-2' },
        ]),
      } as never,
      {
        find: jest.fn(async () => [
          { coupleId: 'personal-own' },
          { coupleId: 'personal-foreign' },
          { coupleId: 'shared-1' },
        ]),
      } as never,
      {
        find: jest.fn(async () => [
          { id: 'participant-own', coupleId: 'personal-own' },
          { id: 'participant-foreign', coupleId: 'personal-foreign' },
          { id: 'participant-shared', coupleId: 'shared-1' },
        ]),
      } as never,
      { createQueryBuilder: jest.fn(() => expenseQuery) } as never,
      { find: jest.fn(async () => []) } as never,
      { resolveSpaceForUser: jest.fn(async () => ({})) } as never,
    );

    await service.listForUser('user-1');

    expect(expenseQuery.where).toHaveBeenCalledWith(
      'expense.coupleId IN (:...spaceIds)',
      expect.objectContaining({
        spaceIds: ['personal-own', 'shared-1'],
        personalSpaceIds: ['personal-own'],
        participantIds: ['participant-own', 'participant-shared'],
      }),
    );
  });
});
