import {
  calculateCategoryTotals,
  generateCategoryChartData,
  filterExpensesByDate,
  getRelevantExpenses,
  isNextPeriodDisabled,
  getDisplayPeriodText,
  getPreviousPeriod,
  getNextPeriod,
} from '../calculations/insightCalculations';
import { mockExpenses, mockCategories, createMockExpense } from '../../__tests__/fixtures';

describe('insightCalculations', () => {
  describe('calculateCategoryTotals', () => {
    it('should calculate correct category totals', () => {
      const expenses = [
        createMockExpense({ category: 'Food & Dining', amount: 50 }),
        createMockExpense({ category: 'Food & Dining', amount: 30 }),
        createMockExpense({ category: 'Transportation', amount: 20 }),
      ];

      const result = calculateCategoryTotals(expenses);

      expect(result.totals).toEqual({
        'Food & Dining': 80,
        'Transportation': 20,
      });
      expect(result.total).toBe(100);
    });

    it('should handle single expense', () => {
      const expenses = [
        createMockExpense({ category: 'Food & Dining', amount: 50 }),
      ];

      const result = calculateCategoryTotals(expenses);

      expect(result.totals).toEqual({
        'Food & Dining': 50,
      });
      expect(result.total).toBe(50);
    });

    it('should return empty totals for no expenses', () => {
      const result = calculateCategoryTotals([]);

      expect(result.totals).toEqual({});
      expect(result.total).toBe(0);
    });

    it('should handle decimal amounts correctly', () => {
      const expenses = [
        createMockExpense({ category: 'Food & Dining', amount: 25.50 }),
        createMockExpense({ category: 'Food & Dining', amount: 12.75 }),
      ];

      const result = calculateCategoryTotals(expenses);

      expect(result.totals['Food & Dining']).toBe(38.25);
      expect(result.total).toBe(38.25);
    });

    it('should handle zero amounts', () => {
      const expenses = [
        createMockExpense({ category: 'Food & Dining', amount: 0 }),
        createMockExpense({ category: 'Transportation', amount: 25 }),
      ];

      const result = calculateCategoryTotals(expenses);

      expect(result.totals).toEqual({
        'Food & Dining': 0,
        'Transportation': 25,
      });
      expect(result.total).toBe(25);
    });
  });

  describe('generateCategoryChartData', () => {
    it('should generate chart data with correct percentages', () => {
      const expenses = [
        createMockExpense({ category: 'Food & Dining', amount: 80 }),
        createMockExpense({ category: 'Transportation', amount: 20 }),
      ];

      const result = generateCategoryChartData(expenses, mockCategories);

      expect(result).toHaveLength(2);

      const foodData = result.find(d => d.category === 'Food & Dining');
      const transportData = result.find(d => d.category === 'Transportation');

      expect(foodData).toMatchObject({
        value: 80,
        label: 'Food & Dining',
        text: 'Food & Dining',
        color: '#FF5722',
        category: 'Food & Dining',
        absoluteValue: 80,
        percentage: 80,
      });

      expect(transportData).toMatchObject({
        value: 20,
        label: 'Transportation',
        text: 'Transportation',
        color: '#2196F3',
        category: 'Transportation',
        absoluteValue: 20,
        percentage: 20,
      });
    });

    it('should handle categories not in category list with default color', () => {
      const expenses = [
        createMockExpense({ category: 'Unknown Category', amount: 50 }),
      ];

      const result = generateCategoryChartData(expenses, mockCategories, '#CCCCCC');

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        value: 50,
        label: 'Unknown Category',
        color: '#CCCCCC',
        percentage: 100,
      });
    });

    it('should return empty array for no expenses', () => {
      const result = generateCategoryChartData([], mockCategories);
      expect(result).toEqual([]);
    });

    it('should return empty array for zero total', () => {
      const expenses = [
        createMockExpense({ category: 'Food & Dining', amount: 0 }),
      ];

      const result = generateCategoryChartData(expenses, mockCategories);
      expect(result).toEqual([]);
    });

    it('should calculate percentages correctly for multiple categories', () => {
      const expenses = [
        createMockExpense({ category: 'Food & Dining', amount: 60 }),
        createMockExpense({ category: 'Transportation', amount: 30 }),
        createMockExpense({ category: 'Entertainment', amount: 10 }),
      ];

      const result = generateCategoryChartData(expenses, mockCategories);

      expect(result).toHaveLength(3);
      expect(result.find(d => d.category === 'Food & Dining')?.percentage).toBe(60);
      expect(result.find(d => d.category === 'Transportation')?.percentage).toBe(30);
      expect(result.find(d => d.category === 'Entertainment')?.percentage).toBe(10);
    });
  });

  describe('filterExpensesByDate', () => {
    const testExpenses = [
      createMockExpense({ title: 'Jan 2025', date: '2025-01-15', amount: 100 }),
      createMockExpense({ title: 'Mar 2025', date: '2025-03-10', amount: 150 }),
      createMockExpense({ title: 'Jan 2024', date: '2024-01-20', amount: 200 }),
      createMockExpense({ title: 'Dec 2024', date: '2024-12-25', amount: 75 }),
    ];

    it('should filter by year correctly', () => {
      const result = filterExpensesByDate(testExpenses, 'year', 2025);

      expect(result).toHaveLength(2);
      expect(result.map(e => e.title)).toContain('Jan 2025');
      expect(result.map(e => e.title)).toContain('Mar 2025');
    });

    it('should filter by month and year correctly', () => {
      const result = filterExpensesByDate(testExpenses, 'month', 2025, 0); // January = 0

      expect(result).toHaveLength(1);
      expect(result[0].title).toBe('Jan 2025');
    });

    it('should return empty array for no matching dates', () => {
      const result = filterExpensesByDate(testExpenses, 'year', 2023);
      expect(result).toEqual([]);
    });

    it('should handle edge case of month boundaries', () => {
      const testExpenses = [
        createMockExpense({ title: 'Last day of Jan', date: '2025-01-31', amount: 100 }),
        createMockExpense({ title: 'First day of Feb', date: '2025-02-01', amount: 150 }),
      ];

      const janResult = filterExpensesByDate(testExpenses, 'month', 2025, 0);
      const febResult = filterExpensesByDate(testExpenses, 'month', 2025, 1);

      expect(janResult).toHaveLength(1);
      expect(janResult[0].title).toBe('Last day of Jan');
      expect(febResult).toHaveLength(1);
      expect(febResult[0].title).toBe('First day of Feb');
    });
  });

  describe('getRelevantExpenses', () => {
    const testExpenses = [
      createMockExpense({ title: 'Personal 1', paidBy: 'user-1', groupId: undefined }),
      createMockExpense({ title: 'Personal 2', paidBy: 'user-1', groupId: 'some-group' }),
      createMockExpense({ title: 'Group 1', paidBy: 'user-2', groupId: 'group-1' }),
      createMockExpense({ title: 'Group 2', paidBy: 'user-1', groupId: 'group-1' }),
      createMockExpense({ title: 'Other Group', paidBy: 'user-3', groupId: 'group-2' }),
    ];

    it('should return personal expenses for user', () => {
      const result = getRelevantExpenses(testExpenses, 'personal', '', 'user-1');

      expect(result).toHaveLength(3); // All expenses paid by user-1
      expect(result.map(e => e.title)).toContain('Personal 1');
      expect(result.map(e => e.title)).toContain('Personal 2');
      expect(result.map(e => e.title)).toContain('Group 2');
    });

    it('should return group expenses for specified group', () => {
      const result = getRelevantExpenses(testExpenses, 'group', 'group-1', 'user-1');

      expect(result).toHaveLength(2);
      expect(result.map(e => e.title)).toContain('Group 1');
      expect(result.map(e => e.title)).toContain('Group 2');
    });

    it('should return empty array for personal context without internal user ID', () => {
      const result = getRelevantExpenses(testExpenses, 'personal', '', null);
      expect(result).toEqual([]);
    });

    it('should return empty array for non-existent group', () => {
      const result = getRelevantExpenses(testExpenses, 'group', 'non-existent', 'user-1');
      expect(result).toEqual([]);
    });
  });

  describe('isNextPeriodDisabled', () => {
    // Mock current date for consistent testing
    const mockCurrentDate = new Date('2025-09-19');

    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(mockCurrentDate);
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should disable next period for current month', () => {
      const result = isNextPeriodDisabled(2025, 8, 'month'); // September = 8
      expect(result).toBe(true);
    });

    it('should disable next period for future months', () => {
      const result = isNextPeriodDisabled(2025, 9, 'month'); // October = 9
      expect(result).toBe(true);
    });

    it('should enable next period for past months', () => {
      const result = isNextPeriodDisabled(2025, 7, 'month'); // August = 7
      expect(result).toBe(false);
    });

    it('should disable next period for current year', () => {
      const result = isNextPeriodDisabled(2025, 8, 'year');
      expect(result).toBe(true);
    });

    it('should disable next period for future years', () => {
      const result = isNextPeriodDisabled(2026, 8, 'year');
      expect(result).toBe(true);
    });

    it('should enable next period for past years', () => {
      const result = isNextPeriodDisabled(2024, 8, 'year');
      expect(result).toBe(false);
    });
  });

  describe('getDisplayPeriodText', () => {
    const monthNames = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'
    ];

    it('should return month and year for month aggregation', () => {
      const result = getDisplayPeriodText(2025, 8, 'month', monthNames);
      expect(result).toBe('September 2025');
    });

    it('should return year only for year aggregation', () => {
      const result = getDisplayPeriodText(2025, 8, 'year', monthNames);
      expect(result).toBe('2025');
    });

    it('should handle edge months correctly', () => {
      const janResult = getDisplayPeriodText(2025, 0, 'month', monthNames);
      const decResult = getDisplayPeriodText(2025, 11, 'month', monthNames);

      expect(janResult).toBe('January 2025');
      expect(decResult).toBe('December 2025');
    });
  });

  describe('getPreviousPeriod', () => {
    it('should navigate to previous month within same year', () => {
      const result = getPreviousPeriod(2025, 8, 'month'); // September
      expect(result).toEqual({ year: 2025, month: 7 }); // August
    });

    it('should navigate to previous year when going from January', () => {
      const result = getPreviousPeriod(2025, 0, 'month'); // January
      expect(result).toEqual({ year: 2024, month: 11 }); // December 2024
    });

    it('should navigate to previous year for year aggregation', () => {
      const result = getPreviousPeriod(2025, 8, 'year');
      expect(result).toEqual({ year: 2024, month: 8 });
    });
  });

  describe('getNextPeriod', () => {
    const mockCurrentDate = new Date('2025-09-19');

    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(mockCurrentDate);
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should navigate to next month within same year if not future', () => {
      const result = getNextPeriod(2025, 7, 'month'); // August
      expect(result).toEqual({ year: 2025, month: 8 }); // September
    });

    it('should navigate to next year when going from December', () => {
      const result = getNextPeriod(2024, 11, 'month'); // December 2024
      expect(result).toEqual({ year: 2025, month: 0 }); // January 2025
    });

    it('should return null for current month (cannot go to future)', () => {
      const result = getNextPeriod(2025, 8, 'month'); // September (current)
      expect(result).toBeNull();
    });

    it('should return null for future months', () => {
      const result = getNextPeriod(2025, 9, 'month'); // October (future)
      expect(result).toBeNull();
    });

    it('should navigate to next year if not future', () => {
      const result = getNextPeriod(2024, 8, 'year');
      expect(result).toEqual({ year: 2025, month: 8 });
    });

    it('should return null for current year (cannot go to future)', () => {
      const result = getNextPeriod(2025, 8, 'year');
      expect(result).toBeNull();
    });

    it('should return null for future years', () => {
      const result = getNextPeriod(2026, 8, 'year');
      expect(result).toBeNull();
    });
  });
});