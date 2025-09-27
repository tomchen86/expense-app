import { Expense } from '../../entities/expense.entity';
import { ExpenseGroup } from '../../entities/expense-group.entity';
import { UserSettings } from '../../entities/user-settings.entity';
import { ExpenseSplit } from '../../entities/expense-split.entity';
import { GroupMember } from '../../entities/group-member.entity';
import { User } from '../../entities/user.entity';

export interface MobileExpense {
  id: string;
  title: string;
  amount: number; // In dollars (25.50, not 2550 cents)
  date: string; // ISO string format
  category: string; // Category name, not UUID
  groupId?: string;
  paidBy?: string;
  splitBetween?: string[];
  notes?: string;
}

export interface MobileExpenseGroup {
  id: string;
  name: string;
  description?: string;
  participants: string[];
  createdDate: string;
}

export interface MobileCategory {
  name: string;
  color: string;
}

export interface MobileUserSettings {
  preferredCurrency: string;
  dateFormat: string;
  defaultSplitMethod: string;
}

export interface MobileParticipant {
  id: string;
  name: string;
  email?: string;
}

/**
 * Validates expense response matches mobile app format
 */
export function validateMobileExpenseResponse(
  response: unknown,
): response is MobileExpense {
  return (
    typeof response === 'object' &&
    response !== null &&
    typeof (response as any).id === 'string' &&
    typeof (response as any).title === 'string' &&
    typeof (response as any).amount === 'number' &&
    typeof (response as any).date === 'string' &&
    typeof (response as any).category === 'string' && // Must be category name, not UUID
    ((response as any).groupId === undefined ||
      typeof (response as any).groupId === 'string') &&
    ((response as any).paidBy === undefined ||
      typeof (response as any).paidBy === 'string') &&
    ((response as any).splitBetween === undefined ||
      Array.isArray((response as any).splitBetween)) &&
    ((response as any).notes === undefined ||
      typeof (response as any).notes === 'string')
  );
}

/**
 * Validates expense group response matches mobile app format
 */
export function validateMobileExpenseGroupResponse(
  response: unknown,
): response is MobileExpenseGroup {
  return (
    typeof response === 'object' &&
    response !== null &&
    typeof (response as any).id === 'string' &&
    typeof (response as any).name === 'string' &&
    ((response as any).description === undefined ||
      typeof (response as any).description === 'string') &&
    Array.isArray((response as any).participants) &&
    typeof (response as any).createdDate === 'string'
  );
}

/**
 * Validates category response matches mobile app format
 */
export function validateMobileCategoryResponse(
  response: unknown,
): response is MobileCategory {
  return (
    typeof response === 'object' &&
    response !== null &&
    typeof (response as any).name === 'string' &&
    typeof (response as any).color === 'string'
  );
}

/**
 * Validates user settings response matches mobile app format
 */
export function validateMobileUserSettingsResponse(
  response: unknown,
): response is MobileUserSettings {
  return (
    typeof response === 'object' &&
    response !== null &&
    typeof (response as any).preferredCurrency === 'string' &&
    typeof (response as any).dateFormat === 'string' &&
    typeof (response as any).defaultSplitMethod === 'string'
  );
}

/**
 * Validates participant response matches mobile app format
 */
export function validateMobileParticipantResponse(
  response: unknown,
): response is MobileParticipant {
  return (
    typeof response === 'object' &&
    response !== null &&
    typeof (response as any).id === 'string' &&
    typeof (response as any).name === 'string' &&
    ((response as any).email === undefined ||
      typeof (response as any).email === 'string')
  );
}

/**
 * Converts database expense entity to mobile format
 */
export function convertExpenseToMobileFormat(
  expense: Partial<
    Expense & {
      splits: Partial<ExpenseSplit & { participant: { id: string } }>[];
      category: { name: string };
      group: { id: string };
      payer: { id: string };
    }
  >,
): MobileExpense {
  const splits = Array.isArray(expense.splits) ? expense.splits : [];
  return {
    id: expense.id ?? '',
    title: expense.description ?? '',
    amount: Number((Number(expense.amountCents ?? 0) / 100).toFixed(2)),
    date:
      typeof expense.expenseDate === 'string'
        ? expense.expenseDate
        : ((expense.expenseDate as any)?.toString() ?? ''),
    category: expense.category?.name ?? '',
    groupId: expense.group?.id ?? expense.groupId,
    paidBy: expense.payer?.id ?? expense.paidByParticipantId,
    splitBetween: splits.map((split) => split.participant?.id ?? ''),
    notes: expense.notes,
  };
}

/**
 * Converts database expense group entity to mobile format
 */
export function convertExpenseGroupToMobileFormat(
  group: Partial<
    ExpenseGroup & {
      members: Partial<GroupMember & { participant: { id: string } }>[];
    }
  >,
): MobileExpenseGroup {
  const members = Array.isArray(group.members) ? group.members : [];
  return {
    id: group.id ?? '',
    name: group.name ?? '',
    description: group.description,
    participants: members.map((member) => member.participant?.id ?? '') || [],
    createdDate:
      group.createdAt instanceof Date
        ? group.createdAt.toISOString()
        : ((group.createdAt as any)?.toString() ?? new Date().toISOString()),
  };
}

/**
 * Converts database user settings entity to mobile format
 */
export function convertUserSettingsToMobileFormat(
  settings: Partial<
    UserSettings & {
      user: Partial<User>;
      dateFormat?: string;
      defaultSplitMethod?: string;
    }
  >,
): MobileUserSettings {
  return {
    preferredCurrency: settings.user?.defaultCurrency ?? 'USD',
    dateFormat: settings.dateFormat ?? 'MM/DD/YYYY',
    defaultSplitMethod: settings.defaultSplitMethod ?? 'equal',
  };
}
