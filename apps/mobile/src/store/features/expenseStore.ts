import { create } from "zustand";
import { Expense } from "../../types";

// Helper to generate a simple unique ID
const generateId = () => Math.random().toString(36).substr(2, 9);

export interface ExpenseStoreState {
  expenses: Expense[];

  // Actions
  addExpense: (expense: Omit<Expense, "id">) => void;
  updateExpense: (expense: Expense) => void;
  deleteExpense: (id: string) => void;
  getExpenseById: (id: string) => Expense | undefined;

  // Data migration helpers
  migrateOrphanedExpenses: (internalUserId: string) => void;
  removeExpensesForGroup: (groupId: string) => void;
  updateExpensesForParticipantRemoval: (participantId: string) => void;
}

export const useExpenseStore = create<ExpenseStoreState>((set, get) => ({
  expenses: [],

  addExpense: (expense) => {
    const newExpenseWithId = {
      ...expense,
      id: generateId(),
    };
    set((state) => ({
      expenses: [...state.expenses, newExpenseWithId].sort(
        (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
      ),
    }));
  },

  updateExpense: (updatedExpense) =>
    set((state) => ({
      expenses: state.expenses
        .map((expense) =>
          expense.id === updatedExpense.id ? updatedExpense : expense,
        )
        .sort(
          (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
        ),
    })),

  deleteExpense: (id) =>
    set((state) => ({
      expenses: state.expenses.filter((expense) => expense.id !== id),
    })),

  getExpenseById: (id) => get().expenses.find((expense) => expense.id === id),

  migrateOrphanedExpenses: (internalUserId: string) => {
    set((state) => ({
      expenses: state.expenses.map((exp) => {
        if (!exp.groupId && !exp.paidBy) {
          return {
            ...exp,
            groupId: internalUserId,
            paidBy: internalUserId,
          };
        }
        return exp;
      }),
    }));
  },

  removeExpensesForGroup: (groupId: string) => {
    set((state) => ({
      expenses: state.expenses.map((expense) =>
        expense.groupId === groupId
          ? { ...expense, groupId: undefined }
          : expense,
      ),
    }));
  },

  updateExpensesForParticipantRemoval: (participantId: string) => {
    set((state) => ({
      expenses: state.expenses.map((expense) => ({
        ...expense,
        paidBy: expense.paidBy === participantId ? undefined : expense.paidBy,
        splitBetween: expense.splitBetween?.filter(
          (pid) => pid !== participantId,
        ),
      })),
    }));
  },
}));
