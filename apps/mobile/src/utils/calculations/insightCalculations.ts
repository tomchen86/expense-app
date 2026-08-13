import { Expense, ExpenseCategory, Category } from '../../types';
import {
  getExpenseAmountMinor,
  getExpenseCurrency,
  getExpenseSpaceId,
  getPersonalExpenseProjection,
  isExpenseDeleted,
} from '../expenseDomain';
import { minorUnitsToMajor, parseLocalCalendarDate } from '../money';

export interface ChartDataPoint {
  value: number;
  label: string;
  text: string;
  color: string;
  category: ExpenseCategory;
  absoluteValue: number;
  percentage: number;
  currency?: string;
}

export interface CategoryTotals {
  [key: string]: number;
}

/**
 * Calculate category totals from a list of expenses
 */
export const calculateCategoryTotals = (
  expenses: Expense[],
): { totals: CategoryTotals; total: number } => {
  const totals: CategoryTotals = {};
  let totalAmount = 0;

  expenses.forEach((expense) => {
    const amount = minorUnitsToMajor(
      getExpenseAmountMinor(expense),
      getExpenseCurrency(expense),
    );
    totals[expense.category] = (totals[expense.category] || 0) + amount;
    totalAmount += amount;
  });

  return { totals, total: totalAmount };
};

/**
 * Generate chart data for category visualization
 */
export const generateCategoryChartData = (
  expenses: Expense[],
  categories: Category[],
  defaultColor: string = '#808080',
  amountMinorSelector?: (expense: Expense) => number,
): ChartDataPoint[] => {
  if (expenses.length === 0) {
    return [];
  }

  const totals = new Map<
    string,
    { category: ExpenseCategory; currency: string; amountMinor: number }
  >();
  const currencyTotals = new Map<string, number>();
  expenses.forEach((expense) => {
    const amountMinor = (amountMinorSelector ?? getExpenseAmountMinor)(expense);
    if (amountMinor <= 0) {
      return;
    }
    const currency = getExpenseCurrency(expense);
    const key = `${currency}\u0000${expense.category}`;
    const existing = totals.get(key);
    totals.set(key, {
      category: expense.category,
      currency,
      amountMinor: (existing?.amountMinor ?? 0) + amountMinor,
    });
    currencyTotals.set(
      currency,
      (currencyTotals.get(currency) ?? 0) + amountMinor,
    );
  });

  if (totals.size === 0) {
    return [];
  }

  return [...totals.values()].map(({ category, currency, amountMinor }) => {
    const categoryDetails = categories.find((c) => c.name === category);
    const absoluteValue = minorUnitsToMajor(amountMinor, currency);

    return {
      value: absoluteValue,
      label: category,
      text: category,
      color: categoryDetails ? categoryDetails.color : defaultColor,
      category,
      currency,
      absoluteValue,
      percentage: (amountMinor / (currencyTotals.get(currency) ?? 1)) * 100,
    };
  });
};

/**
 * Filter expenses by date range
 */
export const filterExpensesByDate = (
  expenses: Expense[],
  aggregation: 'month' | 'year',
  selectedYear: number,
  selectedMonth?: number,
): Expense[] => {
  return expenses.filter((expense) => {
    const expenseDate = parseLocalCalendarDate(expense.date);
    if (!expenseDate) {
      return false;
    }

    if (aggregation === 'year') {
      return expenseDate.getFullYear() === selectedYear;
    } else {
      // month aggregation
      return (
        expenseDate.getFullYear() === selectedYear &&
        expenseDate.getMonth() === selectedMonth
      );
    }
  });
};

/**
 * Get expenses relevant to the context (personal or group)
 */
export const getRelevantExpenses = (
  allExpenses: Expense[],
  contextType: 'personal' | 'group',
  contextId: string,
  internalUserId: string | null,
  personalSpaceId?: string,
  participantIds: string[] = internalUserId ? [internalUserId] : [],
): Expense[] => {
  if (contextType === 'personal' && internalUserId) {
    return allExpenses.filter(
      (expense) =>
        !isExpenseDeleted(expense) &&
        ((expense.spaceKind === 'personal' &&
          getExpenseSpaceId(expense) === personalSpaceId) ||
          participantIds.some(
            (participantId) =>
              getPersonalExpenseProjection(expense, participantId) !== null,
          )),
    );
  } else if (contextType === 'group') {
    return allExpenses.filter(
      (expense) =>
        !isExpenseDeleted(expense) && getExpenseSpaceId(expense) === contextId,
    );
  }

  return [];
};

/**
 * Check if next period navigation should be disabled
 */
export const isNextPeriodDisabled = (
  selectedYear: number,
  selectedMonth: number,
  aggregation: 'month' | 'year',
): boolean => {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();

  if (aggregation === 'month') {
    return (
      selectedYear > currentYear ||
      (selectedYear === currentYear && selectedMonth >= currentMonth)
    );
  }

  return selectedYear >= currentYear;
};

/**
 * Get display text for current period
 */
export const getDisplayPeriodText = (
  selectedYear: number,
  selectedMonth: number,
  aggregation: 'month' | 'year',
  monthNames: string[],
): string => {
  if (aggregation === 'month') {
    return `${monthNames[selectedMonth]} ${selectedYear}`;
  }
  return selectedYear.toString();
};

/**
 * Navigate to previous period
 */
export const getPreviousPeriod = (
  selectedYear: number,
  selectedMonth: number,
  aggregation: 'month' | 'year',
): { year: number; month: number } => {
  if (aggregation === 'month') {
    let newMonth = selectedMonth - 1;
    let newYear = selectedYear;

    if (newMonth < 0) {
      newMonth = 11; // December
      newYear -= 1;
    }

    return { year: newYear, month: newMonth };
  } else {
    return { year: selectedYear - 1, month: selectedMonth };
  }
};

/**
 * Navigate to next period (with bounds checking)
 */
export const getNextPeriod = (
  selectedYear: number,
  selectedMonth: number,
  aggregation: 'month' | 'year',
): { year: number; month: number } | null => {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();

  if (aggregation === 'month') {
    let newMonth = selectedMonth + 1;
    let newYear = selectedYear;

    if (newMonth > 11) {
      newMonth = 0; // January
      newYear += 1;
    }

    // Prevent going past current month/year
    if (
      newYear > currentYear ||
      (newYear === currentYear && newMonth > currentMonth)
    ) {
      return null; // Cannot navigate to future
    }

    return { year: newYear, month: newMonth };
  } else {
    const newYear = selectedYear + 1;

    // Prevent going past current year
    if (newYear > currentYear) {
      return null; // Cannot navigate to future
    }

    return { year: newYear, month: selectedMonth };
  }
};
