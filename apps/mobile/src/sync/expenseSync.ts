import type {
  Expense,
  ExpenseSpaceKind,
  ExpenseSyncMetadata,
  MoneyAllocation,
} from '../types';
import { validateCanonicalExpense } from '../utils/expenseDomain';
import { isUuid } from '../utils/ids';
import { parseLocalCalendarDate } from '../utils/money';

export interface ExpenseSplitApiDto {
  participant_id: string;
  share_cents: number;
}

export interface CreateExpenseApiRequest {
  id: string;
  client_mutation_id: string;
  space_id: string;
  description: string;
  amount_cents: number;
  currency: string;
  expense_date: string;
  category_id?: string;
  paid_by_participant_id: string;
  split_type: 'custom';
  splits: ExpenseSplitApiDto[];
  notes?: string;
}

export interface UpdateExpenseApiRequest {
  expense_id: string;
  space_id: string;
  body: Omit<
    CreateExpenseApiRequest,
    'id' | 'client_mutation_id' | 'space_id'
  > & {
    expected_version: number;
  };
}

export interface DeleteExpenseApiRequest {
  expense_id: string;
  space_id: string;
  expected_version: number;
}

export interface ExpenseSyncFeedRecord {
  id: string;
  clientMutationId: string | null;
  spaceId: string;
  version: number;
  updatedAt: string;
  deletedAt: string | null;
  expense: null | {
    description: string;
    amountMinor: string;
    currency: string;
    expenseDate: string;
    categoryId: string | null;
    payerParticipantId: string | null;
    splitType: string;
    notes: string | null;
    payments: Array<{ participantId: string; amountMinor: string }>;
    shares: Array<{ participantId: string; amountMinor: string }>;
  };
}

const assertUuid = (value: unknown, field: string): string => {
  if (!isUuid(value)) {
    throw new Error(`${field} must be a UUID.`);
  }
  return value;
};

const readServerVersion = (expense: Expense): number =>
  expense.sync?.serverVersion ??
  (expense.sync?.status === 'synced' ? (expense.sync.version ?? 0) : 0);

const parseMinor = (
  value: string,
  field: string,
  allowZero = false,
): number => {
  const pattern = allowZero ? /^(0|[1-9]\d*)$/ : /^[1-9]\d*$/;
  if (!pattern.test(value)) {
    throw new Error(
      `${field} must be a ${allowZero ? 'non-negative' : 'positive'} minor-unit integer.`,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${field} exceeds safe integer range.`);
  }
  return parsed;
};

const assertApiCompatibleExpense = (expense: Expense) => {
  if (
    expense.payments?.length !== 1 ||
    expense.payments[0].amountMinor !== expense.amountMinor
  ) {
    throw new Error('The API supports exactly one full-amount payment.');
  }
  if (!validateCanonicalExpense(expense)) {
    throw new Error('Only canonical balanced expenses can be synchronized.');
  }
  if (!expense.sync) {
    throw new Error('Expense sync metadata is required.');
  }
  assertUuid(expense.id, 'expenseId');
  assertUuid(expense.spaceId, 'spaceId');
  assertUuid(expense.sync.mutationId, 'clientMutationId');
  if (expense.categoryId !== undefined) {
    assertUuid(expense.categoryId, 'categoryId');
  }

  assertUuid(expense.payments![0].participantId, 'payerParticipantId');
  expense.shares!.forEach((share) =>
    assertUuid(share.participantId, 'shareParticipantId'),
  );
};

const commonBody = (expense: Expense) => ({
  description: expense.title,
  amount_cents: expense.amountMinor!,
  currency: expense.currency!,
  expense_date: expense.date,
  ...(expense.categoryId !== undefined
    ? { category_id: expense.categoryId }
    : {}),
  paid_by_participant_id: expense.payments![0].participantId,
  split_type: 'custom' as const,
  splits: expense.shares!.map((share) => ({
    participant_id: share.participantId,
    share_cents: share.amountMinor,
  })),
  ...(expense.caption ? { notes: expense.caption } : {}),
});

export const toCreateExpenseApiRequest = (
  expense: Expense,
): CreateExpenseApiRequest => {
  assertApiCompatibleExpense(expense);
  if (readServerVersion(expense) !== 0 || expense.sync!.deletedAt) {
    throw new Error('Create requests require an active unsynced expense.');
  }
  return {
    id: expense.id,
    client_mutation_id: expense.sync!.mutationId,
    space_id: expense.spaceId!,
    ...commonBody(expense),
  };
};

export const toUpdateExpenseApiRequest = (
  expense: Expense,
): UpdateExpenseApiRequest => {
  assertApiCompatibleExpense(expense);
  const serverVersion = readServerVersion(expense);
  if (serverVersion < 1 || expense.sync!.deletedAt) {
    throw new Error('Update requests require an active synchronized expense.');
  }
  return {
    expense_id: expense.id,
    space_id: expense.spaceId!,
    body: { expected_version: serverVersion, ...commonBody(expense) },
  };
};

export const toDeleteExpenseApiRequest = (
  expense: Expense,
): DeleteExpenseApiRequest => {
  if (!expense.sync?.deletedAt) {
    throw new Error('Delete requests require a tombstone.');
  }
  const serverVersion = readServerVersion(expense);
  if (serverVersion < 1) {
    throw new Error('An unsynced create has no server record to delete.');
  }
  return {
    expense_id: assertUuid(expense.id, 'expenseId'),
    space_id: assertUuid(expense.spaceId, 'spaceId'),
    expected_version: serverVersion,
  };
};

const mapFeedAllocations = (
  allocations: Array<{ participantId: string; amountMinor: string }>,
  field: string,
  allowZero = false,
): MoneyAllocation[] =>
  allocations.map((allocation) => ({
    participantId: assertUuid(
      allocation.participantId,
      `${field}.participantId`,
    ),
    amountMinor: parseMinor(
      allocation.amountMinor,
      `${field}.amountMinor`,
      allowZero,
    ),
  }));

export type ExpenseSyncFeedMutation =
  | { operation: 'upsert'; expense: Expense }
  | {
      operation: 'delete';
      expenseId: string;
      spaceId: string;
      sync: ExpenseSyncMetadata;
    };

export const fromExpenseSyncRecord = (
  record: ExpenseSyncFeedRecord,
  options: {
    spaceKind: ExpenseSpaceKind;
    resolveCategoryName?: (categoryId: string) => string | undefined;
  },
): ExpenseSyncFeedMutation => {
  const expenseId = assertUuid(record.id, 'expenseId');
  const spaceId = assertUuid(record.spaceId, 'spaceId');
  if (!Number.isSafeInteger(record.version) || record.version < 1) {
    throw new Error('version must be a positive integer.');
  }
  if (!Number.isFinite(Date.parse(record.updatedAt))) {
    throw new Error('updatedAt must be an ISO date-time.');
  }
  const sync: ExpenseSyncMetadata = {
    mutationId: record.clientMutationId ?? expenseId,
    serverVersion: record.version,
    localRevision: 0,
    status: 'synced',
    updatedAt: record.updatedAt,
    ...(record.deletedAt ? { deletedAt: record.deletedAt } : {}),
  };

  if (record.deletedAt) {
    if (
      record.expense !== null ||
      !Number.isFinite(Date.parse(record.deletedAt))
    ) {
      throw new Error(
        'A tombstone requires a valid deletedAt and null expense.',
      );
    }
    return { operation: 'delete', expenseId, spaceId, sync };
  }
  if (!record.expense) {
    throw new Error('An active sync record requires expense data.');
  }
  const remote = record.expense;
  const amountMinor = parseMinor(remote.amountMinor, 'amountMinor');
  if (!/^[A-Z]{3}$/.test(remote.currency)) {
    throw new Error('currency must be an uppercase three-letter code.');
  }
  if (!parseLocalCalendarDate(remote.expenseDate)) {
    throw new Error('expenseDate must be a local calendar date.');
  }
  const payments = mapFeedAllocations(remote.payments, 'payments');
  const shares = mapFeedAllocations(remote.shares, 'shares', true);
  if (payments.length !== 1 || payments[0].amountMinor !== amountMinor) {
    throw new Error('The API feed requires exactly one full-amount payment.');
  }
  if (
    shares.reduce((sum, share) => sum + share.amountMinor, 0) !== amountMinor
  ) {
    throw new Error('shares must total amountMinor.');
  }
  const categoryId = remote.categoryId
    ? assertUuid(remote.categoryId, 'categoryId')
    : undefined;
  return {
    operation: 'upsert',
    expense: {
      id: expenseId,
      title: remote.description,
      amountMinor,
      currency: remote.currency,
      date: remote.expenseDate,
      category:
        (categoryId && options.resolveCategoryName?.(categoryId)) ??
        'Uncategorized',
      ...(categoryId ? { categoryId } : {}),
      ...(remote.notes ? { caption: remote.notes } : {}),
      spaceId,
      spaceKind: options.spaceKind,
      payments,
      shares,
      sync,
    },
  };
};
