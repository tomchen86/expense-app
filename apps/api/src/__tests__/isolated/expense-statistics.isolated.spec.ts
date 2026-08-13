import { ExpenseService } from '../../services/expense.service';

const aggregateQuery = (rows: unknown[]) => ({
  select: jest.fn().mockReturnThis(),
  addSelect: jest.fn().mockReturnThis(),
  groupBy: jest.fn().mockReturnThis(),
  addGroupBy: jest.fn().mockReturnThis(),
  getRawMany: jest.fn(async () => rows),
});

describe('ExpenseService currency-safe statistics', () => {
  it('returns exact per-currency totals instead of adding unlike minor units', async () => {
    const currencyQuery = aggregateQuery([
      { currency: 'AUD', amountCents: '1200' },
      { currency: 'JPY', amountCents: '500' },
    ]);
    const categoryQuery = aggregateQuery([
      { categoryId: 'category-1', currency: 'AUD', amountCents: '1200' },
      { categoryId: 'category-1', currency: 'JPY', amountCents: '500' },
    ]);
    const participantQuery = aggregateQuery([
      { participantId: 'payer-1', currency: 'AUD', amountCents: '1200' },
      { participantId: 'payer-2', currency: 'JPY', amountCents: '500' },
    ]);
    const baseQuery = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      getCount: jest.fn(async () => 2),
      clone: jest
        .fn()
        .mockReturnValueOnce(currencyQuery)
        .mockReturnValueOnce(categoryQuery)
        .mockReturnValueOnce(participantQuery),
    };
    const expenseRepository = {
      createQueryBuilder: jest.fn(() => baseQuery),
    };
    const service = new ExpenseService(
      expenseRepository as never,
      {} as never,
      {} as never,
      {} as never,
      {
        resolveSpaceForUser: jest.fn(async () => ({ coupleId: 'space-1' })),
      } as never,
      {} as never,
    );

    await expect(
      service.getExpenseStatisticsForUser('user-1', {}),
    ).resolves.toEqual({
      totalTransactions: 2,
      totalsByCurrency: [
        { currency: 'AUD', amountCents: '1200' },
        { currency: 'JPY', amountCents: '500' },
      ],
      totalsByCategory: [
        {
          categoryId: 'category-1',
          currency: 'AUD',
          amountCents: '1200',
        },
        {
          categoryId: 'category-1',
          currency: 'JPY',
          amountCents: '500',
        },
      ],
      totalsByParticipant: [
        {
          participantId: 'payer-1',
          currency: 'AUD',
          amountCents: '1200',
        },
        {
          participantId: 'payer-2',
          currency: 'JPY',
          amountCents: '500',
        },
      ],
    });

    expect(currencyQuery.groupBy).toHaveBeenCalledWith('expense.currency');
    expect(categoryQuery.addGroupBy).toHaveBeenCalledWith('expense.currency');
    expect(participantQuery.addGroupBy).toHaveBeenCalledWith(
      'expense.currency',
    );
  });
});
