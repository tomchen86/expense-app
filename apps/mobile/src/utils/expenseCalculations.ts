import { Expense } from '../types';
import {
  getExpenseAmountMinor,
  getExpenseCurrency,
  getPersonalExpenseProjection,
} from './expenseDomain';
import { minorUnitsToMajor } from './money';

/**
 * Calculates the total amount from a list of expenses.
 * @param expenses - An array of Expense objects.
 * @returns The sum of all expense amounts.
 */
export const calculateTotalExpenses = (expenses: Expense[]): number => {
  return expenses.reduce(
    (sum, expense) =>
      sum +
      minorUnitsToMajor(
        getExpenseAmountMinor(expense),
        getExpenseCurrency(expense),
      ),
    0,
  );
};

export const calculateUserShareMinor = (
  expense: Expense,
  userId: string | null | undefined,
): number => {
  if (userId) {
    return getPersonalExpenseProjection(expense, userId)?.mySpentMinor ?? 0;
  }

  if (
    !expense.spaceId &&
    !expense.groupId &&
    !expense.paidBy &&
    (!expense.splitBetween || expense.splitBetween.length === 0)
  ) {
    return getExpenseAmountMinor(expense);
  }
  return 0;
};

export const calculateUserPaidMinor = (
  expense: Expense,
  userId: string | null | undefined,
): number =>
  userId
    ? (getPersonalExpenseProjection(expense, userId)?.myPaidMinor ?? 0)
    : 0;

/**
 * Calculates the user's share of a single expense.
 * If the expense is split, the share is amount / number of people in split.
 * If not split and paid by user, share is full amount.
 * Otherwise, share is 0.
 * @param expense - The expense object.
 * @param userId - The ID of the user, or null/undefined if the user is anonymous.
 * @returns The user's share of the expense.
 */
export const calculateUserShare = (
  expense: Expense,
  userId: string | null | undefined,
): number => {
  return minorUnitsToMajor(
    calculateUserShareMinor(expense, userId),
    getExpenseCurrency(expense),
  );
};

// Add other general expense-related calculation functions here if needed.
