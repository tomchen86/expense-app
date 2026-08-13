import { Expense, ExpenseGroup, Participant } from '../types';
import {
  getExpenseAmountMinor,
  getExpenseCurrency,
  getExpensePayments,
  getExpenseShares,
  getExpenseSpaceId,
  isExpenseDeleted,
} from './expenseDomain';
import { minorUnitsToMajor } from './money';

export interface CurrencyTotal {
  currency: string;
  amountMinor: number;
}

export const resolveGroupParticipantIdForUser = (
  group: ExpenseGroup | undefined,
  internalUserId: string | null,
): string | null => {
  if (!group || !internalUserId) {
    return null;
  }

  return (
    group.participants.find(
      (participant) => participant.userId === internalUserId,
    )?.id ??
    group.participants.find((participant) => participant.id === internalUserId)
      ?.id ??
    null
  );
};

export const calculateGroupTotalsByCurrency = (
  expenses: Expense[],
  groupId: string,
): CurrencyTotal[] => {
  const totals = new Map<string, number>();
  expenses
    .filter(
      (expense) =>
        !isExpenseDeleted(expense) && getExpenseSpaceId(expense) === groupId,
    )
    .forEach((expense) => {
      const currency = getExpenseCurrency(expense);
      totals.set(
        currency,
        (totals.get(currency) ?? 0) + getExpenseAmountMinor(expense),
      );
    });
  return [...totals.entries()].map(([currency, amountMinor]) => ({
    currency,
    amountMinor,
  }));
};

// Legacy major-unit facade retained for older callers and persisted records.
export const calculateGroupTotal = (
  expenses: Expense[],
  groupId: string,
): number =>
  calculateGroupTotalsByCurrency(expenses, groupId).reduce(
    (sum, total) => sum + minorUnitsToMajor(total.amountMinor, total.currency),
    0,
  );

export const calculateUserTotalContributionMinorInGroup = (
  userId: string,
  expenses: Expense[],
  groupId: string,
): CurrencyTotal[] => {
  const totals = new Map<string, number>();
  expenses
    .filter(
      (expense) =>
        !isExpenseDeleted(expense) && getExpenseSpaceId(expense) === groupId,
    )
    .forEach((expense) => {
      const amountMinor = getExpensePayments(expense)
        .filter((payment) => payment.participantId === userId)
        .reduce((sum, payment) => sum + payment.amountMinor, 0);
      if (amountMinor > 0) {
        const currency = getExpenseCurrency(expense);
        totals.set(currency, (totals.get(currency) ?? 0) + amountMinor);
      }
    });
  return [...totals.entries()].map(([currency, amountMinor]) => ({
    currency,
    amountMinor,
  }));
};

export const calculateUserTotalContributionInGroup = (
  userId: string,
  expenses: Expense[],
  groupId: string,
): number =>
  calculateUserTotalContributionMinorInGroup(userId, expenses, groupId).reduce(
    (sum, total) => sum + minorUnitsToMajor(total.amountMinor, total.currency),
    0,
  );

export interface MemberBalanceDetails {
  memberId: string;
  memberName: string;
  currency: string;
  totalPaidMinor: number;
  totalShareMinor: number;
  netBalanceMinor: number;
  /** @deprecated major-unit compatibility */
  totalPaid: number;
  /** @deprecated major-unit compatibility */
  totalShare: number;
  /** @deprecated major-unit compatibility */
  netBalance: number;
}

export const calculateAllMemberBalancesInGroup = (
  groupMembers: Participant[],
  groupExpenses: Expense[],
  allParticipants: Participant[] = groupMembers,
): MemberBalanceDetails[] => {
  if (groupMembers.length === 0 && groupExpenses.length === 0) {
    return [];
  }

  const names = new Map<string, string>();
  const activeExpenses = groupExpenses.filter(
    (expense) => !isExpenseDeleted(expense),
  );
  [...allParticipants, ...groupMembers].forEach((participant) =>
    names.set(participant.id, participant.name),
  );
  activeExpenses.forEach((expense) =>
    expense.participants?.forEach((participant) =>
      names.set(participant.id, participant.name),
    ),
  );

  const balances = new Map<
    string,
    { memberId: string; currency: string; paid: number; share: number }
  >();
  const ensureBalance = (memberId: string, currency: string) => {
    const key = `${memberId}\u0000${currency}`;
    const existing = balances.get(key);
    if (existing) {
      return existing;
    }
    const created = { memberId, currency, paid: 0, share: 0 };
    balances.set(key, created);
    return created;
  };

  activeExpenses.forEach((expense) => {
    const currency = getExpenseCurrency(expense);
    groupMembers.forEach((member) => ensureBalance(member.id, currency));
    getExpensePayments(expense).forEach((payment) => {
      ensureBalance(payment.participantId, currency).paid +=
        payment.amountMinor;
    });
    getExpenseShares(expense).forEach((share) => {
      ensureBalance(share.participantId, currency).share += share.amountMinor;
    });
  });

  return [...balances.values()].map(({ memberId, currency, paid, share }) => {
    const net = paid - share;
    return {
      memberId,
      memberName: names.get(memberId) ?? 'Former participant',
      currency,
      totalPaidMinor: paid,
      totalShareMinor: share,
      netBalanceMinor: net,
      totalPaid: minorUnitsToMajor(paid, currency),
      totalShare: minorUnitsToMajor(share, currency),
      netBalance: minorUnitsToMajor(net, currency),
    };
  });
};
