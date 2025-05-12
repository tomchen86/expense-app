import { Expense } from "../types";

/**
 * Calculates the total amount of expenses for a specific group.
 * @param expenses - The full list of expenses.
 * @param groupId - The ID of the group to calculate the total for.
 * @returns The total amount for the group.
 */
export const calculateGroupTotal = (
  expenses: Expense[],
  groupId: string
): number => {
  return expenses
    .filter((e) => e.groupId === groupId) // Filter expenses for the group
    .reduce((sum, e) => sum + e.amount, 0); // Sum the amounts
};

// Add other group-related calculation functions here if needed in the future
// e.g., calculateUserShare, calculateGroupBalance, etc.
