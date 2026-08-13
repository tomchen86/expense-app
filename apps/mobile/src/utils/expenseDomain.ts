import type { Expense, ExpenseSpaceKind, MoneyAllocation } from '../types';
import { allocateEqualShares, getCurrencyFractionDigits } from './money';

export interface PersonalExpenseProjection {
  expense: Expense;
  currency: string;
  myPaidMinor: number;
  mySpentMinor: number;
  myBalanceMinor: number;
}

const isPositiveMinorAmount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

const isNonNegativeMinorAmount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export const getExpenseCurrency = (expense: Expense): string =>
  expense.currency ?? 'USD';

export const isExpenseDeleted = (expense: Expense): boolean =>
  typeof expense.sync?.deletedAt === 'string';

export const getExpenseAmountMinor = (expense: Expense): number => {
  if (isPositiveMinorAmount(expense.amountMinor)) {
    return expense.amountMinor;
  }

  if (typeof expense.amount !== 'number' || !Number.isFinite(expense.amount)) {
    return 0;
  }

  const fractionDigits = getCurrencyFractionDigits(getExpenseCurrency(expense));
  const amountMinor = Math.round(expense.amount * 10 ** (fractionDigits ?? 2));
  return isPositiveMinorAmount(amountMinor) ? amountMinor : 0;
};

export const getExpenseSpaceId = (expense: Expense): string | undefined =>
  expense.spaceId ?? expense.groupId;

export const getExpenseSpaceKind = (
  expense: Expense,
): ExpenseSpaceKind | undefined =>
  expense.spaceKind ?? (expense.groupId ? 'shared' : undefined);

const validAllocations = (
  allocations: MoneyAllocation[] | undefined,
  isValidAmount: (value: unknown) => value is number,
): MoneyAllocation[] =>
  (allocations ?? []).filter(
    (allocation) =>
      typeof allocation.participantId === 'string' &&
      allocation.participantId.length > 0 &&
      isValidAmount(allocation.amountMinor),
  );

export const getExpensePayments = (expense: Expense): MoneyAllocation[] => {
  const canonical = validAllocations(expense.payments, isPositiveMinorAmount);
  if (canonical.length > 0) {
    return canonical;
  }

  const amountMinor = getExpenseAmountMinor(expense);
  return expense.paidBy && amountMinor > 0
    ? [{ participantId: expense.paidBy, amountMinor }]
    : [];
};

export const getExpenseShares = (expense: Expense): MoneyAllocation[] => {
  const canonical = validAllocations(expense.shares, isNonNegativeMinorAmount);
  if (canonical.length > 0) {
    return canonical;
  }

  const amountMinor = getExpenseAmountMinor(expense);
  const legacyParticipantIds =
    expense.splitBetween && expense.splitBetween.length > 0
      ? expense.splitBetween
      : expense.participants && expense.participants.length > 0
        ? expense.participants.map((participant) => participant.id)
        : expense.paidBy
          ? [expense.paidBy]
          : [];
  return allocateEqualShares(amountMinor, legacyParticipantIds);
};

export const sumAllocationsForParticipant = (
  allocations: MoneyAllocation[],
  participantId: string,
): number =>
  allocations
    .filter((allocation) => allocation.participantId === participantId)
    .reduce((sum, allocation) => sum + allocation.amountMinor, 0);

export const getPersonalExpenseProjection = (
  expense: Expense,
  participantId: string,
): PersonalExpenseProjection | null => {
  if (isExpenseDeleted(expense)) {
    return null;
  }
  const myPaidMinor = sumAllocationsForParticipant(
    getExpensePayments(expense),
    participantId,
  );
  const mySpentMinor = sumAllocationsForParticipant(
    getExpenseShares(expense),
    participantId,
  );

  if (myPaidMinor === 0 && mySpentMinor === 0) {
    return null;
  }

  return {
    expense,
    currency: getExpenseCurrency(expense),
    myPaidMinor,
    mySpentMinor,
    myBalanceMinor: myPaidMinor - mySpentMinor,
  };
};

export const validateCanonicalExpense = (expense: Expense): boolean => {
  const amountMinor = getExpenseAmountMinor(expense);
  const payments = validAllocations(expense.payments, isPositiveMinorAmount);
  const shares = validAllocations(expense.shares, isNonNegativeMinorAmount);
  return (
    isPositiveMinorAmount(expense.amountMinor) &&
    typeof expense.currency === 'string' &&
    getCurrencyFractionDigits(expense.currency) !== null &&
    typeof expense.spaceId === 'string' &&
    expense.spaceId.length > 0 &&
    (expense.spaceKind === 'personal' || expense.spaceKind === 'shared') &&
    payments.length === expense.payments?.length &&
    shares.length === expense.shares?.length &&
    payments.reduce((sum, item) => sum + item.amountMinor, 0) === amountMinor &&
    shares.reduce((sum, item) => sum + item.amountMinor, 0) === amountMinor
  );
};
