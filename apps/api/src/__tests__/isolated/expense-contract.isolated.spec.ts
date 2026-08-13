process.env.DB_DRIVER = 'sqljs';
process.env.NODE_ENV = 'test';

import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateExpenseDto, DeleteExpenseQueryDto } from '../../dto/expense.dto';
import { ExpenseService } from '../../services/expense.service';

describe('expense aggregate contract', () => {
  const basePayload = {
    description: 'Dinner',
    amount_cents: 1000,
    currency: 'USD',
    expense_date: '2026-08-13',
    paid_by_participant_id: '708f2f50-8d6d-4f54-baaa-15bd7ce0ce51',
    split_type: 'custom' as const,
    splits: [
      {
        participant_id: '708f2f50-8d6d-4f54-baaa-15bd7ce0ce51',
        share_cents: 1000,
      },
    ],
  };

  it.each([1000.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an invalid cent value %p at the DTO boundary',
    (amountCents) => {
      const dto = plainToInstance(CreateExpenseDto, {
        ...basePayload,
        amount_cents: amountCents,
        splits: [{ ...basePayload.splits[0], share_cents: amountCents }],
      });

      const errors = validateSync(dto, {
        whitelist: true,
        forbidNonWhitelisted: true,
      });
      expect(errors.map((error) => error.property)).toContain('amount_cents');
    },
  );

  it('requires an expected version for delete mutations', () => {
    const dto = plainToInstance(DeleteExpenseQueryDto, {
      space_id: '708f2f50-8d6d-4f54-baaa-15bd7ce0ce51',
    });
    expect(
      validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }).map(
        (error) => error.property,
      ),
    ).toContain('expected_version');
  });

  const createSplitValidationService = () => {
    const participantService = {
      assertParticipantsBelongToCouple: jest.fn().mockResolvedValue([]),
    };
    return {
      participantService,
      service: new ExpenseService(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        participantService as never,
      ),
    };
  };

  it('rejects a non-canonical equal remainder allocation', async () => {
    const { service } = createSplitValidationService();
    await expect(
      service['validateAndNormalizeSplits'](
        'space-1',
        [
          { participant_id: 'participant-1', share_cents: 2 },
          { participant_id: 'participant-2', share_cents: 3 },
        ],
        5,
        'equal',
        'participant-1',
      ),
    ).rejects.toMatchObject({
      response: {
        error: { code: 'INVALID_EQUAL_SPLITS' },
      },
    });
  });

  it('rejects percentage cents that contradict the percentage allocation', async () => {
    const { service } = createSplitValidationService();
    await expect(
      service['validateAndNormalizeSplits'](
        'space-1',
        [
          {
            participant_id: 'participant-1',
            share_cents: 400,
            share_percent: 50,
          },
          {
            participant_id: 'participant-2',
            share_cents: 600,
            share_percent: 50,
          },
        ],
        1000,
        'percentage',
        'participant-1',
      ),
    ).rejects.toMatchObject({
      response: {
        error: { code: 'INVALID_PERCENTAGE_SPLITS' },
      },
    });
  });

  it('validates but does not require the payer to consume a share', async () => {
    const { service, participantService } = createSplitValidationService();
    await expect(
      service['validateAndNormalizeSplits'](
        'space-1',
        [{ participant_id: 'consumer-1', share_cents: 1000 }],
        1000,
        'custom',
        'payer-1',
      ),
    ).resolves.toEqual([
      {
        participantId: 'consumer-1',
        shareCents: 1000,
        sharePercent: undefined,
      },
    ]);
    expect(
      participantService.assertParticipantsBelongToCouple,
    ).toHaveBeenCalledWith('space-1', ['consumer-1', 'payer-1']);
  });

  it('persists the resolved space on every new split row', async () => {
    const transactionExpenseRepository = {
      create: jest.fn(() => ({})),
      save: jest.fn((expense) =>
        Promise.resolve({
          ...expense,
          id: 'expense-1',
          version: 1,
          createdAt: new Date('2026-08-13T00:00:00.000Z'),
          updatedAt: new Date('2026-08-13T00:00:00.000Z'),
        }),
      ),
    };
    const transactionSplitRepository = {
      create: jest.fn(() => ({})),
      save: jest.fn((splits) => Promise.resolve(splits)),
      find: jest
        .fn()
        .mockImplementation(() =>
          Promise.resolve(
            transactionSplitRepository.save.mock.calls[0]?.[0] ?? [],
          ),
        ),
    };
    const manager = {
      getRepository: jest
        .fn()
        .mockReturnValueOnce(transactionExpenseRepository)
        .mockReturnValueOnce(transactionSplitRepository),
    };
    const service = new ExpenseService(
      {
        findOne: jest.fn().mockResolvedValue(null),
        manager: {
          transaction: jest.fn(
            (callback: (transactionManager: typeof manager) => unknown) =>
              Promise.resolve().then(() => callback(manager)),
          ),
        },
      } as never,
      {} as never,
      { findOne: jest.fn().mockResolvedValue(null) } as never,
      { findOne: jest.fn().mockResolvedValue(null) } as never,
      {
        resolveSpaceForUser: jest.fn().mockResolvedValue({
          spaceId: 'space-1',
          coupleId: 'space-1',
          kind: 'shared',
          participantId: 'payer-1',
        }),
      } as never,
      {
        assertParticipantsBelongToCouple: jest.fn().mockResolvedValue([]),
      } as never,
    );

    await service.createExpenseForUser('user-1', {
      description: 'Dinner',
      amount_cents: 1000,
      currency: 'USD',
      expense_date: '2026-08-13',
      paid_by_participant_id: 'payer-1',
      split_type: 'custom',
      splits: [{ participant_id: 'consumer-1', share_cents: 1000 }],
      space_id: 'space-1',
    });

    expect(transactionSplitRepository.save).toHaveBeenCalledWith([
      expect.objectContaining({
        coupleId: 'space-1',
        expenseId: 'expense-1',
        participantId: 'consumer-1',
      }),
    ]);
  });

  it('preserves split rows when an update does not contain splits', async () => {
    const existingSplit = {
      id: 'split-1',
      expenseId: 'expense-1',
      participantId: 'participant-1',
      shareCents: '2500',
      settledAt: new Date('2026-08-01T00:00:00.000Z'),
    };
    const existingExpense = {
      id: 'expense-1',
      coupleId: 'space-1',
      clientMutationId: undefined,
      groupId: undefined,
      categoryId: undefined,
      createdBy: 'user-1',
      paidByParticipantId: 'participant-1',
      description: 'Dinner',
      amountCents: '2500',
      currency: 'USD',
      exchangeRate: undefined,
      expenseDate: '2026-08-01',
      splitType: 'custom',
      notes: undefined,
      receiptUrl: undefined,
      location: undefined,
      version: 1,
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    };

    const updateBuilder = {
      update: jest.fn(),
      set: jest.fn(),
      where: jest.fn(),
      andWhere: jest.fn(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    for (const method of ['update', 'set', 'where', 'andWhere'] as const) {
      updateBuilder[method].mockReturnValue(updateBuilder);
    }

    const transactionExpenseRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(updateBuilder),
      findOneByOrFail: jest.fn().mockResolvedValue({
        ...existingExpense,
        notes: 'metadata only',
        version: 2,
      }),
    };
    const transactionSplitRepository = {
      delete: jest.fn(),
      save: jest.fn(),
      find: jest.fn().mockResolvedValue([existingSplit]),
    };
    const manager = {
      getRepository: jest
        .fn()
        .mockReturnValueOnce(transactionExpenseRepository)
        .mockReturnValueOnce(transactionSplitRepository),
    };
    const expenseRepository = {
      findOne: jest.fn().mockResolvedValue(existingExpense),
      manager: {
        transaction: jest.fn(
          (callback: (transactionManager: typeof manager) => unknown) =>
            Promise.resolve().then(() => callback(manager)),
        ),
      },
    };
    const expenseSplitRepository = {
      find: jest.fn().mockResolvedValue([existingSplit]),
    };
    const ledgerService = {
      resolveSpaceForUser: jest.fn().mockResolvedValue({
        spaceId: 'space-1',
        coupleId: 'space-1',
        kind: 'personal',
        participantId: 'participant-1',
      }),
    };

    const service = new ExpenseService(
      expenseRepository as never,
      expenseSplitRepository as never,
      {} as never,
      {} as never,
      ledgerService as never,
      {} as never,
    );

    const result = await service.updateExpenseForUser(
      'user-1',
      'expense-1',
      { expected_version: 1, notes: 'metadata only' },
      'space-1',
    );

    expect(transactionSplitRepository.delete).not.toHaveBeenCalled();
    expect(transactionSplitRepository.save).not.toHaveBeenCalled();
    expect(result.splits).toEqual([
      expect.objectContaining({
        participant_id: 'participant-1',
        share_cents: 2500,
      }),
    ]);
    expect(result.version).toBe(2);
    expect(ledgerService.resolveSpaceForUser).toHaveBeenCalledWith(
      'user-1',
      'space-1',
      { ensureParticipant: true },
    );
  });

  it('replays an existing client mutation without creating another expense', async () => {
    const existingExpense = {
      id: 'expense-1',
      coupleId: 'space-1',
      clientMutationId: 'mutation-1',
      createdBy: 'user-1',
      paidByParticipantId: basePayload.paid_by_participant_id,
      description: 'Dinner',
      amountCents: '1000',
      currency: 'USD',
      expenseDate: '2026-08-13',
      splitType: 'custom',
      version: 1,
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    };
    const transaction = jest.fn();
    const ledgerService = {
      resolveSpaceForUser: jest.fn().mockResolvedValue({
        spaceId: 'space-1',
        coupleId: 'space-1',
        kind: 'personal',
        participantId: 'participant-1',
      }),
    };
    const service = new ExpenseService(
      {
        findOne: jest.fn().mockResolvedValue(existingExpense),
        manager: { transaction },
      } as never,
      {
        find: jest.fn().mockResolvedValue([
          {
            expenseId: 'expense-1',
            participantId: basePayload.paid_by_participant_id,
            shareCents: '1000',
          },
        ]),
      } as never,
      {} as never,
      {} as never,
      ledgerService as never,
      {} as never,
    );

    const result = await service.createExpenseForUser('user-1', {
      ...basePayload,
      client_mutation_id: 'mutation-1',
      space_id: 'space-1',
    });

    expect(result.id).toBe('expense-1');
    expect(result.client_mutation_id).toBe('mutation-1');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rejects reuse of a client mutation ID for a different expense payload', async () => {
    const transaction = jest.fn();
    const service = new ExpenseService(
      {
        findOne: jest.fn().mockResolvedValue({
          id: 'expense-1',
          coupleId: 'space-1',
          clientMutationId: 'mutation-1',
          createdBy: 'user-1',
          paidByParticipantId: basePayload.paid_by_participant_id,
          description: 'Dinner',
          amountCents: '1000',
          currency: 'USD',
          expenseDate: '2026-08-13',
          splitType: 'custom',
          version: 1,
          createdAt: new Date('2026-08-13T00:00:00.000Z'),
          updatedAt: new Date('2026-08-13T00:00:00.000Z'),
        }),
        manager: { transaction },
      } as never,
      {
        find: jest.fn().mockResolvedValue([
          {
            expenseId: 'expense-1',
            participantId: basePayload.paid_by_participant_id,
            shareCents: '1000',
          },
        ]),
      } as never,
      {} as never,
      {} as never,
      {
        resolveSpaceForUser: jest.fn().mockResolvedValue({
          spaceId: 'space-1',
          coupleId: 'space-1',
          kind: 'personal',
          participantId: basePayload.paid_by_participant_id,
        }),
      } as never,
      {} as never,
    );

    await expect(
      service.createExpenseForUser('user-1', {
        ...basePayload,
        amount_cents: 2000,
        splits: [{ ...basePayload.splits[0], share_cents: 2000 }],
        client_mutation_id: 'mutation-1',
        space_id: 'space-1',
      }),
    ).rejects.toMatchObject({
      response: {
        error: {
          code: 'CLIENT_MUTATION_ID_CONFLICT',
          field: 'client_mutation_id',
        },
      },
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rejects an update whose expected version is stale', async () => {
    const transaction = jest.fn();
    const service = new ExpenseService(
      {
        findOne: jest.fn().mockResolvedValue({
          id: 'expense-1',
          coupleId: 'space-1',
          version: 2,
        }),
        manager: { transaction },
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {
        resolveSpaceForUser: jest.fn().mockResolvedValue({
          spaceId: 'space-1',
          coupleId: 'space-1',
          kind: 'personal',
        }),
      } as never,
      {} as never,
    );

    await expect(
      service.updateExpenseForUser(
        'user-1',
        'expense-1',
        { expected_version: 1, notes: 'stale' },
        'space-1',
      ),
    ).rejects.toMatchObject({
      response: {
        error: {
          code: 'EXPENSE_VERSION_CONFLICT',
          field: 'expected_version',
          details: { currentVersion: 2 },
        },
      },
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("does not let an ordinary member edit another member's expense", async () => {
    const transaction = jest.fn();
    const service = new ExpenseService(
      {
        findOne: jest.fn().mockResolvedValue({
          id: 'expense-1',
          coupleId: 'space-1',
          createdBy: 'user-2',
          version: 1,
        }),
        manager: { transaction },
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {
        resolveSpaceForUser: jest.fn().mockResolvedValue({
          spaceId: 'space-1',
          coupleId: 'space-1',
          kind: 'shared',
          role: 'member',
        }),
      } as never,
      {} as never,
    );

    await expect(
      service.updateExpenseForUser(
        'user-1',
        'expense-1',
        { expected_version: 1, notes: 'not mine' },
        'space-1',
      ),
    ).rejects.toMatchObject({
      response: {
        error: { code: 'EXPENSE_EDIT_FORBIDDEN' },
      },
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rejects a delete whose expected version is stale', async () => {
    const update = jest.fn();
    const service = new ExpenseService(
      {
        findOne: jest.fn().mockResolvedValue({
          id: 'expense-1',
          coupleId: 'space-1',
          version: 2,
        }),
        createQueryBuilder: jest.fn(() => ({ update })),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {
        resolveSpaceForUser: jest.fn().mockResolvedValue({
          spaceId: 'space-1',
          coupleId: 'space-1',
          kind: 'personal',
        }),
      } as never,
      {} as never,
    );

    await expect(
      service.deleteExpenseForUser('user-1', 'expense-1', 1, 'space-1'),
    ).rejects.toMatchObject({
      response: {
        error: {
          code: 'EXPENSE_VERSION_CONFLICT',
          field: 'expected_version',
          details: { currentVersion: 2 },
        },
      },
    });
    expect(update).not.toHaveBeenCalled();
  });
});
