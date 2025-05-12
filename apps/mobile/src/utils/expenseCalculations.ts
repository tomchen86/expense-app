import { Expense } from "../types";

/**
 * Calculates the total amount from a list of expenses.
 * @param expenses - An array of Expense objects.
 * @returns The sum of all expense amounts.
 */
export const calculateTotalExpenses = (expenses: Expense[]): number => {
  return expenses.reduce((sum, expense) => sum + expense.amount, 0);
};

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
  userId: string | null | undefined
): number => {
  // Case 1: Expense is split
  if (expense.splitBetween && expense.splitBetween.length > 0) {
    if (userId && expense.splitBetween.includes(userId)) {
      return expense.amount / expense.splitBetween.length;
    }
    return 0; // User is not in the split, or user is anonymous and it's a group split
  }

  // Case 2: Expense is not split
  if (userId && expense.paidBy === userId) {
    return expense.amount; // User paid the full amount
  }

  // Case 3: Personal expense viewed by an anonymous user (no userId, no split, no specific paidBy)
  // or an expense not paid by the current known user and not split with them.
  if (
    !userId &&
    !expense.groupId &&
    !expense.paidBy &&
    (!expense.splitBetween || expense.splitBetween.length === 0)
  ) {
    return expense.amount; // Anonymous user sees full amount of their own unassigned personal expenses
  }

  if (!userId && expense.paidBy) {
    // Personal expense paid by someone else, anonymous user sees 0
    return 0;
  }

  // Default: User is not involved or it's a personal expense not paid by them (if userId is known)
  return 0;
};

// Add other general expense-related calculation functions here if needed.
