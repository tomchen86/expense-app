import { Expense, Participant } from "../types";

/**
 * Calculates the total amount of expenses for a specific group.
 * @param expenses - The full list of expenses.
 * @param groupId - The ID of the group to calculate the total for.
 * @returns The total amount for the group.
 */
export const calculateGroupTotal = (
  expenses: Expense[],
  groupId: string,
): number => {
  return expenses
    .filter((e) => e.groupId === groupId) // Filter expenses for the group
    .reduce((sum, e) => sum + e.amount, 0); // Sum the amounts
};

/**
 * Calculates the total amount a specific user has paid for expenses within a specific group.
 * @param userId - The ID of the user.
 * @param expenses - The list of all expenses.
 * @param groupId - The ID of the group.
 * @returns The total amount paid by the user in the group.
 */
export const calculateUserTotalContributionInGroup = (
  userId: string,
  expenses: Expense[],
  groupId: string,
): number => {
  return expenses
    .filter((e) => e.groupId === groupId && e.paidBy === userId)
    .reduce((sum, e) => sum + e.amount, 0);
};

export interface MemberBalanceDetails {
  memberId: string;
  memberName: string;
  totalPaid: number;
  totalShare: number;
  netBalance: number;
}

/**
 * Calculates the balance for each member in a group.
 * Assumes expenses are split equally among all participants of that expense,
 * or all group members if no specific participants are listed for an expense.
 * @param groupMembers - Array of participants in the group.
 * @param groupExpenses - Array of expenses belonging to the group.
 * @returns An array of objects, each containing memberId, memberName, totalPaid, totalShare, and netBalance.
 */
export const calculateAllMemberBalancesInGroup = (
  groupMembers: Participant[],
  groupExpenses: Expense[],
): MemberBalanceDetails[] => {
  if (!groupMembers || groupMembers.length === 0) {
    return [];
  }

  const memberBalances: Record<string, { paid: number; share: number }> = {};

  groupMembers.forEach((member) => {
    memberBalances[member.id] = { paid: 0, share: 0 };
  });

  groupExpenses.forEach((expense) => {
    // Add to payer's paid amount
    if (expense.paidBy && memberBalances[expense.paidBy]) {
      memberBalances[expense.paidBy].paid += expense.amount;
    }

    // Calculate and add to each participant's share
    // If expense.participants is defined and not empty, use it
    // Otherwise, assume the expense is split among all groupMembers
    const expenseParticipants =
      expense.participants && expense.participants.length > 0
        ? expense.participants
        : groupMembers;

    if (expenseParticipants.length > 0) {
      const sharePerParticipant = expense.amount / expenseParticipants.length;
      expenseParticipants.forEach((participant) => {
        // Ensure the participant is part of the current group context
        if (memberBalances[participant.id]) {
          memberBalances[participant.id].share += sharePerParticipant;
        }
      });
    }
  });

  return groupMembers.map((member) => {
    const paid = memberBalances[member.id]?.paid || 0;
    const share = memberBalances[member.id]?.share || 0;
    return {
      memberId: member.id,
      memberName: member.name,
      totalPaid: paid,
      totalShare: share,
      netBalance: paid - share,
    };
  });
};

// Add other group-related calculation functions here if needed in the future
// e.g., calculateUserShare, calculateGroupBalance, etc.
