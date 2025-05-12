import { create } from "zustand";

export interface Expense {
  id: string;
  title: string;
  amount: number;
  date: string; // Store date as string for simplicity, can be Date object
}

interface ExpenseState {
  expenses: Expense[];
  addExpense: (expense: Omit<Expense, "id">) => void;
}

export const useExpenseStore = create<ExpenseState>((set) => ({
  expenses: [],
  addExpense: (expense) =>
    set((state) => ({
      expenses: [
        ...state.expenses,
        { ...expense, id: Math.random().toString(36).substr(2, 9) }, // Simple ID generation
      ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()), // Sort by date descending
    })),
}));
