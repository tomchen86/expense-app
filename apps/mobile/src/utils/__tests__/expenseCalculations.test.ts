import {
  calculateTotalExpenses,
  calculateUserShare,
} from '../expenseCalculations';
import type { Expense } from '../../types';

describe('expenseCalculations', () => {
  const baseExpense: Expense = {
    id: 'seed',
    title: 'Seed',
    amount: 100,
    date: '2025-01-01',
    category: 'Food & Dining',
  };

  describe('calculateTotalExpenses', () => {
    it('sums all expense amounts', () => {
      const expenses: Expense[] = [
        { ...baseExpense, id: '1', amount: 25 },
        { ...baseExpense, id: '2', amount: 50 },
        { ...baseExpense, id: '3', amount: 12.5 },
      ];

      expect(calculateTotalExpenses(expenses)).toBe(87.5);
    });

    it('returns zero when there are no expenses', () => {
      expect(calculateTotalExpenses([])).toBe(0);
    });
  });

  describe('calculateUserShare', () => {
    it('divides split expenses evenly for participating user', () => {
      const share = calculateUserShare(
        {
          ...baseExpense,
          splitBetween: ['user-1', 'user-2'],
        },
        'user-2',
      );

      expect(share).toBe(50);
    });

    it('returns zero for split expenses when user not included', () => {
      const share = calculateUserShare(
        {
          ...baseExpense,
          splitBetween: ['user-1', 'user-2'],
        },
        'user-3',
      );

      expect(share).toBe(0);
    });

    it('returns full amount for non-split expenses paid by the user', () => {
      const share = calculateUserShare(
        {
          ...baseExpense,
          paidBy: 'user-1',
        },
        'user-1',
      );

      expect(share).toBe(100);
    });

    it('handles anonymous personal expenses without payer', () => {
      const share = calculateUserShare(
        {
          ...baseExpense,
          groupId: undefined,
          paidBy: undefined,
          splitBetween: undefined,
        },
        null,
      );

      expect(share).toBe(100);
    });

    it('returns zero for anonymous viewer when expense has payer', () => {
      const share = calculateUserShare(
        {
          ...baseExpense,
          paidBy: 'user-1',
        },
        null,
      );

      expect(share).toBe(0);
    });

    it('returns zero when user not involved', () => {
      const share = calculateUserShare(
        {
          ...baseExpense,
          paidBy: 'user-1',
        },
        'user-2',
      );

      expect(share).toBe(0);
    });
  });
});
