import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  flushExpensePersistence,
  useExpenseStore as useExpenseFeatureStore,
} from '../features/expenseStore';
import { useUserStore } from '../features/userStore';
import { useCategoryStore } from '../features/categoryStore';
import { useGroupStore } from '../features/groupStore';
import { useParticipantStore } from '../features/participantStore';
import type { Expense } from '../../types';

const storage = AsyncStorage as jest.Mocked<typeof AsyncStorage>;

describe('durable mobile store hydration', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    storage.getItem.mockResolvedValue(null);
    storage.setItem.mockResolvedValue(undefined);
    useExpenseFeatureStore.setState({ expenses: [] });
    await useExpenseFeatureStore.persist.clearStorage();
  });

  it('wires every user-visible domain store to durable storage', () => {
    expect(useExpenseFeatureStore.persist.getOptions().name).toBe(
      'expense-mobile-expenses-v2',
    );
    expect(useUserStore.persist.getOptions().name).toBe(
      'expense-mobile-user-v2',
    );
    expect(useGroupStore.persist.getOptions().name).toBe(
      'expense-mobile-groups-v2',
    );
    expect(useParticipantStore.persist.getOptions().name).toBe(
      'expense-mobile-participants-v2',
    );
    expect(useCategoryStore.persist.getOptions().name).toBe(
      'expense-mobile-categories-v2',
    );
  });

  it('persists a locally-created canonical expense with its stable ID', async () => {
    useExpenseFeatureStore.getState().addExpense({
      title: 'Offline lunch',
      amountMinor: 1250,
      currency: 'AUD',
      date: '2026-08-13',
      category: 'Food & Dining',
      spaceId: 'personal-space-1',
      spaceKind: 'personal',
      payments: [{ participantId: 'user-1', amountMinor: 1250 }],
      shares: [{ participantId: 'user-1', amountMinor: 1250 }],
    });

    await Promise.resolve();
    expect(storage.setItem).toHaveBeenCalledWith(
      'expense-mobile-expenses-v2',
      expect.stringContaining('Offline lunch'),
    );
    const storedExpense = useExpenseFeatureStore.getState().expenses[0];
    expect(storedExpense.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(storedExpense.sync).toMatchObject({
      serverVersion: 0,
      localRevision: 1,
      mutationId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
    });
  });

  it('exposes a flush promise that waits for the durable expense write', async () => {
    let resolveWrite: (() => void) | undefined;
    storage.setItem.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        }),
    );

    useExpenseFeatureStore.getState().addExpense({
      title: 'Await durability',
      amountMinor: 500,
      currency: 'AUD',
      date: '2026-08-13',
      category: 'Food & Dining',
      spaceId: 'personal-space-1',
      spaceKind: 'personal',
      payments: [{ participantId: 'user-1', amountMinor: 500 }],
      shares: [{ participantId: 'user-1', amountMinor: 500 }],
    });

    let flushed = false;
    const flush = flushExpensePersistence().then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(flushed).toBe(false);

    resolveWrite?.();
    await flush;
    expect(flushed).toBe(true);
  });

  it('retains a shared-expense deletion as a durable versioned tombstone', () => {
    useExpenseFeatureStore.setState({
      expenses: [
        {
          id: '13e8dc6b-dcaf-40f1-a524-c10bd1bde7c7',
          title: 'Shared taxi',
          amountMinor: 3000,
          currency: 'AUD',
          date: '2026-08-13',
          category: 'Transportation',
          spaceId: 'space-shared',
          spaceKind: 'shared',
          payments: [{ participantId: 'user-1', amountMinor: 3000 }],
          shares: [{ participantId: 'user-1', amountMinor: 3000 }],
          sync: {
            mutationId: '75f0751e-b199-4778-95de-4f71a9eb5660',
            serverVersion: 2,
            localRevision: 0,
            status: 'synced',
            updatedAt: '2026-08-13T00:00:00.000Z',
          },
        },
      ],
    });

    useExpenseFeatureStore
      .getState()
      .deleteExpense('13e8dc6b-dcaf-40f1-a524-c10bd1bde7c7');

    expect(useExpenseFeatureStore.getState().expenses[0].sync).toMatchObject({
      serverVersion: 2,
      localRevision: 1,
      status: 'pending',
      deletedAt: expect.any(String),
    });
  });

  it('rehydrates the same expense after an offline restart', async () => {
    const expense: Expense = {
      id: 'stable-expense-id',
      title: 'Restored dinner',
      amountMinor: 4200,
      currency: 'AUD',
      date: '2026-08-12',
      category: 'Food & Dining',
      spaceId: 'space-1',
      spaceKind: 'shared',
      payments: [{ participantId: 'user-1', amountMinor: 4200 }],
      shares: [{ participantId: 'user-1', amountMinor: 4200 }],
      sync: {
        mutationId: 'mutation-stable',
        serverVersion: 0,
        localRevision: 1,
        status: 'pending',
        updatedAt: '2026-08-12T00:00:00.000Z',
      },
    };
    storage.getItem.mockResolvedValueOnce(
      JSON.stringify({ state: { expenses: [expense] }, version: 3 }),
    );
    useExpenseFeatureStore.setState({ expenses: [] });

    await useExpenseFeatureStore.persist.rehydrate();

    expect(useExpenseFeatureStore.getState().expenses).toEqual([expense]);
  });

  it('hydrates a durable user and personal-space identity', async () => {
    storage.getItem.mockResolvedValueOnce(
      JSON.stringify({
        state: {
          user: {
            id: 'user-stable',
            displayName: 'Morgan',
            personalSpaceId: 'personal-stable',
          },
          internalUserId: 'user-stable',
          personalSpaceId: 'personal-stable',
        },
        version: 2,
      }),
    );

    await useUserStore.persist.rehydrate();

    expect(useUserStore.getState()).toMatchObject({
      internalUserId: 'user-stable',
      personalSpaceId: 'personal-stable',
      personalParticipantId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
    });
  });

  it('preserves legacy identity and space values while backfilling participant identity', async () => {
    storage.getItem.mockResolvedValueOnce(
      JSON.stringify({
        state: {
          internalUserId: 'user_legacy',
          personalSpaceId: 'personal_legacy',
          userSettings: { name: 'Legacy' },
        },
        version: 2,
      }),
    );

    await useUserStore.persist.rehydrate();

    const state = useUserStore.getState();
    expect(state.internalUserId).toBe('user_legacy');
    expect(state.personalSpaceId).toBe('personal_legacy');
    expect(state.personalParticipantId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
