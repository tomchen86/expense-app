// Mobile app response format validators
// These ensure API responses match exactly what mobile app expects

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
  response: any,
): response is MobileExpense {
  return (
    typeof response === 'object' &&
    typeof response.id === 'string' &&
    typeof response.title === 'string' &&
    typeof response.amount === 'number' &&
    typeof response.date === 'string' &&
    typeof response.category === 'string' && // Must be category name, not UUID
    (response.groupId === undefined || typeof response.groupId === 'string') &&
    (response.paidBy === undefined || typeof response.paidBy === 'string') &&
    (response.splitBetween === undefined ||
      Array.isArray(response.splitBetween)) &&
    (response.notes === undefined || typeof response.notes === 'string')
  );
}

/**
 * Validates expense group response matches mobile app format
 */
export function validateMobileExpenseGroupResponse(
  response: any,
): response is MobileExpenseGroup {
  return (
    typeof response === 'object' &&
    typeof response.id === 'string' &&
    typeof response.name === 'string' &&
    (response.description === undefined ||
      typeof response.description === 'string') &&
    Array.isArray(response.participants) &&
    typeof response.createdDate === 'string'
  );
}

/**
 * Validates category response matches mobile app format
 */
export function validateMobileCategoryResponse(
  response: any,
): response is MobileCategory {
  return (
    typeof response === 'object' &&
    typeof response.name === 'string' &&
    typeof response.color === 'string'
  );
}

/**
 * Validates user settings response matches mobile app format
 */
export function validateMobileUserSettingsResponse(
  response: any,
): response is MobileUserSettings {
  return (
    typeof response === 'object' &&
    typeof response.preferredCurrency === 'string' &&
    typeof response.dateFormat === 'string' &&
    typeof response.defaultSplitMethod === 'string'
  );
}

/**
 * Validates participant response matches mobile app format
 */
export function validateMobileParticipantResponse(
  response: any,
): response is MobileParticipant {
  return (
    typeof response === 'object' &&
    typeof response.id === 'string' &&
    typeof response.name === 'string' &&
    (response.email === undefined || typeof response.email === 'string')
  );
}

/**
 * Converts database expense entity to mobile format
 */
export function convertExpenseToMobileFormat(expense: any): MobileExpense {
  return {
    id: expense.id,
    title: expense.title,
    amount: Number((expense.amount_cents / 100).toFixed(2)), // Convert cents to dollars
    date: expense.expense_date.toISOString(),
    category: expense.category.name, // Use category name, not UUID
    groupId: expense.expense_group?.id,
    paidBy: expense.paid_by?.id,
    splitBetween: expense.expense_splits?.map(
      (split: any) => split.participant.id,
    ),
    notes: expense.notes,
  };
}

/**
 * Converts database expense group entity to mobile format
 */
export function convertExpenseGroupToMobileFormat(
  group: any,
): MobileExpenseGroup {
  return {
    id: group.id,
    name: group.group_name,
    description: group.group_description,
    participants:
      group.group_members?.map((member: any) => member.participant.id) || [],
    createdDate: group.created_date.toISOString(),
  };
}

/**
 * Converts database user settings entity to mobile format
 */
export function convertUserSettingsToMobileFormat(
  settings: any,
): MobileUserSettings {
  return {
    preferredCurrency: settings.preferred_currency,
    dateFormat: settings.date_format,
    defaultSplitMethod: settings.default_split_method,
  };
}
