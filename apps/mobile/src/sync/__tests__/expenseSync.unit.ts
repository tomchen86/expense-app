import type { Expense } from '../../types';
import {
  fromExpenseSyncRecord,
  toCreateExpenseApiRequest,
  toDeleteExpenseApiRequest,
  toUpdateExpenseApiRequest,
} from '../expenseSync';

const EXPENSE_ID = '13e8dc6b-dcaf-40f1-a524-c10bd1bde7c7';
const MUTATION_ID = '75f0751e-b199-4778-95de-4f71a9eb5660';
const SPACE_ID = '2603ca77-4440-4c04-a018-6718e30b4f3c';
const PAYER_ID = '48ca93b4-bd47-4058-b6b7-27305e0942bd';
const SHARE_ID = '27ac46ff-3e5a-45c8-a10d-79b66ddab6c1';
const CATEGORY_ID = 'b7e14585-5388-466e-b815-d21d0f41d20a';

const canonicalExpense = (overrides: Partial<Expense> = {}): Expense => ({
  id: EXPENSE_ID,
  title: 'Shared taxi',
  amountMinor: 3000,
  currency: 'AUD',
  date: '2026-08-13',
  category: 'Transportation',
  categoryId: CATEGORY_ID,
  caption: 'Airport transfer',
  spaceId: SPACE_ID,
  spaceKind: 'shared',
  payments: [{ participantId: PAYER_ID, amountMinor: 3000 }],
  shares: [{ participantId: SHARE_ID, amountMinor: 3000 }],
  sync: {
    mutationId: MUTATION_ID,
    serverVersion: 0,
    localRevision: 1,
    status: 'pending',
    updatedAt: '2026-08-13T00:00:00.000Z',
  },
  ...overrides,
});

describe('expense API request adapters', () => {
  it('maps an unsynced canonical expense to the flat create DTO', () => {
    expect(toCreateExpenseApiRequest(canonicalExpense())).toEqual({
      id: EXPENSE_ID,
      client_mutation_id: MUTATION_ID,
      space_id: SPACE_ID,
      description: 'Shared taxi',
      amount_cents: 3000,
      currency: 'AUD',
      expense_date: '2026-08-13',
      category_id: CATEGORY_ID,
      paid_by_participant_id: PAYER_ID,
      split_type: 'custom',
      splits: [{ participant_id: SHARE_ID, share_cents: 3000 }],
      notes: 'Airport transfer',
    });
  });

  it('uses the unchanged server version for a full-state update request', () => {
    const expense = canonicalExpense({
      sync: {
        mutationId: MUTATION_ID,
        serverVersion: 3,
        localRevision: 2,
        status: 'pending',
        updatedAt: '2026-08-13T01:00:00.000Z',
      },
    });

    expect(toUpdateExpenseApiRequest(expense)).toEqual({
      expense_id: EXPENSE_ID,
      space_id: SPACE_ID,
      body: {
        expected_version: 3,
        description: 'Shared taxi',
        amount_cents: 3000,
        currency: 'AUD',
        expense_date: '2026-08-13',
        category_id: CATEGORY_ID,
        paid_by_participant_id: PAYER_ID,
        split_type: 'custom',
        splits: [{ participant_id: SHARE_ID, share_cents: 3000 }],
        notes: 'Airport transfer',
      },
    });
  });

  it('maps a synced tombstone to the delete route and query contract', () => {
    const expense = canonicalExpense({
      sync: {
        mutationId: MUTATION_ID,
        serverVersion: 3,
        localRevision: 4,
        status: 'pending',
        updatedAt: '2026-08-13T02:00:00.000Z',
        deletedAt: '2026-08-13T02:00:00.000Z',
      },
    });

    expect(toDeleteExpenseApiRequest(expense)).toEqual({
      expense_id: EXPENSE_ID,
      space_id: SPACE_ID,
      expected_version: 3,
    });
  });

  it('rejects multiple and partial payments unsupported by the API', () => {
    expect(() =>
      toCreateExpenseApiRequest(
        canonicalExpense({
          payments: [
            { participantId: PAYER_ID, amountMinor: 1500 },
            { participantId: SHARE_ID, amountMinor: 1500 },
          ],
        }),
      ),
    ).toThrow('exactly one full-amount payment');

    expect(() =>
      toCreateExpenseApiRequest(
        canonicalExpense({
          payments: [{ participantId: PAYER_ID, amountMinor: 1500 }],
        }),
      ),
    ).toThrow('exactly one full-amount payment');
  });

  it('rejects legacy identifiers before constructing an invalid API request', () => {
    expect(() =>
      toCreateExpenseApiRequest(
        canonicalExpense({ spaceId: 'personal_legacy' }),
      ),
    ).toThrow('spaceId must be a UUID');
  });

  it('rejects a legacy category identifier instead of silently dropping it', () => {
    expect(() =>
      toCreateExpenseApiRequest(
        canonicalExpense({ categoryId: 'Transportation' }),
      ),
    ).toThrow('categoryId must be a UUID');
  });
});

describe('expense sync-feed mapper', () => {
  const activeRecord = {
    id: EXPENSE_ID,
    clientMutationId: MUTATION_ID,
    spaceId: SPACE_ID,
    version: 4,
    updatedAt: '2026-08-13T03:00:00.000Z',
    deletedAt: null,
    expense: {
      description: 'Shared taxi',
      amountMinor: '3000',
      currency: 'AUD',
      expenseDate: '2026-08-13',
      categoryId: CATEGORY_ID,
      payerParticipantId: PAYER_ID,
      splitType: 'custom',
      notes: 'Airport transfer',
      payments: [{ participantId: PAYER_ID, amountMinor: '3000' }],
      shares: [{ participantId: SHARE_ID, amountMinor: '3000' }],
    },
  };

  it('validates and maps an active feed record to the canonical local model', () => {
    const result = fromExpenseSyncRecord(activeRecord, {
      spaceKind: 'shared',
      resolveCategoryName: (id) =>
        id === CATEGORY_ID ? 'Transportation' : undefined,
    });

    expect(result).toEqual({
      operation: 'upsert',
      expense: expect.objectContaining({
        id: EXPENSE_ID,
        title: 'Shared taxi',
        amountMinor: 3000,
        currency: 'AUD',
        date: '2026-08-13',
        category: 'Transportation',
        categoryId: CATEGORY_ID,
        spaceId: SPACE_ID,
        spaceKind: 'shared',
        payments: [{ participantId: PAYER_ID, amountMinor: 3000 }],
        shares: [{ participantId: SHARE_ID, amountMinor: 3000 }],
        sync: {
          mutationId: MUTATION_ID,
          serverVersion: 4,
          localRevision: 0,
          status: 'synced',
          updatedAt: '2026-08-13T03:00:00.000Z',
        },
      }),
    });
  });

  it('preserves a valid zero-cent share from a one-cent equal split', () => {
    const result = fromExpenseSyncRecord(
      {
        ...activeRecord,
        expense: {
          ...activeRecord.expense,
          amountMinor: '1',
          payments: [{ participantId: PAYER_ID, amountMinor: '1' }],
          shares: [
            { participantId: PAYER_ID, amountMinor: '1' },
            { participantId: SHARE_ID, amountMinor: '0' },
          ],
        },
      },
      { spaceKind: 'shared' },
    );

    expect(result.operation).toBe('upsert');
    if (result.operation === 'upsert') {
      expect(result.expense.shares).toEqual([
        { participantId: PAYER_ID, amountMinor: 1 },
        { participantId: SHARE_ID, amountMinor: 0 },
      ]);
    }
  });

  it('maps a feed tombstone without inventing financial fields', () => {
    expect(
      fromExpenseSyncRecord(
        {
          ...activeRecord,
          version: 5,
          deletedAt: '2026-08-13T04:00:00.000Z',
          expense: null,
        },
        { spaceKind: 'shared' },
      ),
    ).toEqual({
      operation: 'delete',
      expenseId: EXPENSE_ID,
      spaceId: SPACE_ID,
      sync: {
        mutationId: MUTATION_ID,
        serverVersion: 5,
        localRevision: 0,
        status: 'synced',
        updatedAt: '2026-08-13T03:00:00.000Z',
        deletedAt: '2026-08-13T04:00:00.000Z',
      },
    });
  });

  it('rejects malformed or financially inconsistent feed data', () => {
    expect(() =>
      fromExpenseSyncRecord(
        {
          ...activeRecord,
          expense: {
            ...activeRecord.expense,
            shares: [{ participantId: SHARE_ID, amountMinor: '2999' }],
          },
        },
        { spaceKind: 'shared' },
      ),
    ).toThrow('shares must total amountMinor');
  });
});
