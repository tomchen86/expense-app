import { create } from 'zustand';
import {
  createJSONStorage,
  persist,
  type StateStorage,
} from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Expense } from '../../types';
import {
  getExpenseAmountMinor,
  getExpenseCurrency,
  getExpensePayments,
  getExpenseShares,
  getExpenseSpaceKind,
} from '../../utils/expenseDomain';
import { createUuid } from '../../utils/ids';

const legacyServerVersion = (expense: Expense): number =>
  expense.sync?.serverVersion ??
  (expense.sync?.status === 'synced' ? (expense.sync.version ?? 0) : 0);

const legacyLocalRevision = (expense: Expense): number =>
  expense.sync?.localRevision ??
  (expense.sync?.status === 'synced'
    ? 0
    : Math.max(1, expense.sync?.version ?? 1));

let pendingExpenseWrite: { name: string; value: string } | null = null;
let expenseWritePromise: Promise<void> | null = null;

const scheduleExpenseWrite = (): Promise<void> => {
  if (!expenseWritePromise) {
    expenseWritePromise = Promise.resolve()
      .then(async () => {
        while (pendingExpenseWrite) {
          const write = pendingExpenseWrite;
          pendingExpenseWrite = null;
          await AsyncStorage.setItem(write.name, write.value);
        }
      })
      .finally(() => {
        expenseWritePromise = null;
      });
  }
  return expenseWritePromise;
};

const expenseStateStorage: StateStorage = {
  getItem: (name) => AsyncStorage.getItem(name),
  setItem: (name, value) => {
    pendingExpenseWrite = { name, value };
    return scheduleExpenseWrite();
  },
  removeItem: async (name) => {
    pendingExpenseWrite = null;
    await (expenseWritePromise?.catch(() => undefined) ?? Promise.resolve());
    await AsyncStorage.removeItem(name);
  },
};

export const flushExpensePersistence = (): Promise<void> =>
  expenseWritePromise ??
  (pendingExpenseWrite ? scheduleExpenseWrite() : Promise.resolve());

// Helper to generate a simple unique ID
export interface ExpenseStoreState {
  expenses: Expense[];

  // Actions
  addExpense: (expense: Omit<Expense, 'id' | 'sync'>) => string;
  updateExpense: (expense: Expense) => void;
  deleteExpense: (id: string) => void;
  getExpenseById: (id: string) => Expense | undefined;

  // Data migration helpers
  migrateOrphanedExpenses: (
    internalUserId: string,
    personalSpaceId?: string,
  ) => void;
  removeExpensesForGroup: (groupId: string) => void;
  updateExpensesForParticipantRemoval: (participantId: string) => void;
}

export const useExpenseStore = create<ExpenseStoreState>()(
  persist(
    (set, get) => ({
      expenses: [],

      addExpense: (expense) => {
        const id = createUuid();
        const now = new Date().toISOString();
        const newExpenseWithId: Expense = {
          ...expense,
          id,
          sync: {
            mutationId: createUuid(),
            serverVersion: 0,
            localRevision: 1,
            status: expense.spaceKind === 'shared' ? 'pending' : 'local_only',
            updatedAt: now,
          },
        };
        set((state) => ({
          expenses: [...state.expenses, newExpenseWithId].sort((a, b) =>
            b.date.localeCompare(a.date),
          ),
        }));
        return id;
      },

      updateExpense: (updatedExpense) =>
        set((state) => ({
          expenses: state.expenses
            .map((expense) => {
              if (expense.id !== updatedExpense.id) {
                return expense;
              }
              const merged = { ...expense, ...updatedExpense };
              const canonical =
                updatedExpense.amountMinor !== undefined &&
                updatedExpense.currency &&
                updatedExpense.spaceId &&
                updatedExpense.spaceKind &&
                updatedExpense.payments &&
                updatedExpense.shares
                  ? {
                      id: updatedExpense.id,
                      title: updatedExpense.title,
                      amountMinor: updatedExpense.amountMinor,
                      currency: updatedExpense.currency,
                      date: updatedExpense.date,
                      category: updatedExpense.category,
                      ...(updatedExpense.categoryId
                        ? { categoryId: updatedExpense.categoryId }
                        : {}),
                      spaceId: updatedExpense.spaceId,
                      spaceKind: updatedExpense.spaceKind,
                      payments: updatedExpense.payments,
                      shares: updatedExpense.shares,
                      ...(updatedExpense.caption
                        ? { caption: updatedExpense.caption }
                        : {}),
                    }
                  : merged;
              const nextExpense: Expense = {
                ...canonical,
                sync: {
                  mutationId: createUuid(),
                  serverVersion: legacyServerVersion(expense),
                  localRevision: legacyLocalRevision(expense) + 1,
                  status:
                    canonical.spaceKind === 'shared' ? 'pending' : 'local_only',
                  updatedAt: new Date().toISOString(),
                },
              };
              return nextExpense;
            })
            .sort((a, b) => b.date.localeCompare(a.date)),
        })),

      deleteExpense: (id) =>
        set((state) => ({
          expenses: state.expenses.flatMap((expense) => {
            if (expense.id !== id) {
              return [expense];
            }
            const requiresTombstone =
              getExpenseSpaceKind(expense) === 'shared' ||
              (expense.sync !== undefined &&
                expense.sync.status !== 'local_only');
            if (!requiresTombstone) {
              return [];
            }
            const now = new Date().toISOString();
            return [
              {
                ...expense,
                sync: {
                  mutationId: createUuid(),
                  serverVersion: legacyServerVersion(expense),
                  localRevision: legacyLocalRevision(expense) + 1,
                  status: 'pending' as const,
                  updatedAt: now,
                  deletedAt: now,
                },
              },
            ];
          }),
        })),

      getExpenseById: (id) =>
        get().expenses.find((expense) => expense.id === id),

      migrateOrphanedExpenses: (
        internalUserId: string,
        personalSpaceId = `personal_${internalUserId}`,
      ) => {
        set((state) => ({
          expenses: state.expenses.map((expense) => {
            if (expense.spaceId || expense.groupId) {
              return expense;
            }

            const amountMinor = getExpenseAmountMinor(expense);
            const currency = getExpenseCurrency(expense);
            const payments =
              getExpensePayments(expense).length > 0
                ? getExpensePayments(expense)
                : [{ participantId: internalUserId, amountMinor }];
            const shares =
              getExpenseShares(expense).length > 0
                ? getExpenseShares(expense)
                : [{ participantId: internalUserId, amountMinor }];

            return {
              ...expense,
              amountMinor,
              currency,
              spaceId: personalSpaceId,
              spaceKind: 'personal',
              payments,
              shares,
            };
          }),
        }));
      },

      // Kept for the legacy facade. Historical expenses retain their space ID.
      removeExpensesForGroup: (_groupId: string) => undefined,

      // Membership changes must not rewrite historical payment/share allocations.
      updateExpensesForParticipantRemoval: (_participantId: string) =>
        undefined,
    }),
    {
      name: 'expense-mobile-expenses-v2',
      version: 3,
      storage: createJSONStorage(() => expenseStateStorage),
      partialize: (state) => ({ expenses: state.expenses }),
      migrate: (persistedState) => {
        const state = (persistedState ?? {}) as { expenses?: Expense[] };
        return {
          expenses: (state.expenses ?? []).map((expense) => {
            if (!expense.sync) {
              return expense;
            }
            const { version: _version, ...sync } = expense.sync;
            return {
              ...expense,
              sync: {
                ...sync,
                serverVersion: legacyServerVersion(expense),
                localRevision: legacyLocalRevision(expense),
              },
            };
          }),
        };
      },
    },
  ),
);
