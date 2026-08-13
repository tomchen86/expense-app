export type ProjectionShare = {
  participantId: string;
  amountMinor: string;
};

export type ProjectionExpense = {
  id: string;
  spaceId: string;
  amountMinor: string;
  currency: string;
  payerParticipantId?: string | null;
  shares: ProjectionShare[];
};

export type PersonalExpenseProjection = {
  expenseId: string;
  myPaidMinor: string;
  mySpentMinor: string;
  myBalanceMinor: string;
  currency: string;
};

/**
 * Projects one canonical expense into current-user paid/spent/balance values.
 * Strings preserve PostgreSQL bigint precision at the HTTP boundary.
 */
export const projectExpenseForParticipant = (
  expense: ProjectionExpense,
  participantId: string,
  options: { includeWhenUnallocated?: boolean } = {},
): PersonalExpenseProjection | null => {
  const paid =
    expense.payerParticipantId === participantId
      ? BigInt(expense.amountMinor)
      : 0n;
  const spent = expense.shares.reduce(
    (total, share) =>
      share.participantId === participantId
        ? total + BigInt(share.amountMinor)
        : total,
    0n,
  );

  if (paid === 0n && spent === 0n && !options.includeWhenUnallocated) {
    return null;
  }

  return {
    expenseId: expense.id,
    myPaidMinor: paid.toString(),
    mySpentMinor: spent.toString(),
    myBalanceMinor: (paid - spent).toString(),
    currency: expense.currency,
  };
};
