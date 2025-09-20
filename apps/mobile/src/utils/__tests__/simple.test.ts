import {
  calculateCategoryTotals,
  filterExpensesByDate,
  isNextPeriodDisabled,
  getDisplayPeriodText,
  getPreviousPeriod,
  getNextPeriod,
} from '../calculations/insightCalculations';

// Simple mock expense type for testing
interface SimpleExpense {
  id: string;
  title: string;
  amount: number;
  date: string;
  category: string;
}

describe('Insight Calculations', () => {
  describe('calculateCategoryTotals', () => {
    it('should calculate totals correctly', () => {
      const expenses: SimpleExpense[] = [
        { id: '1', title: 'Coffee', amount: 4.50, date: '2025-09-19', category: 'Food & Dining' },
        { id: '2', title: 'Lunch', amount: 12.50, date: '2025-09-19', category: 'Food & Dining' },
        { id: '3', title: 'Gas', amount: 45.00, date: '2025-09-19', category: 'Transportation' },
      ];

      const result = calculateCategoryTotals(expenses as any);

      expect(result.totals).toEqual({
        'Food & Dining': 17.00,
        'Transportation': 45.00,
      });
      expect(result.total).toBe(62.00);
    });

    it('should handle empty array', () => {
      const result = calculateCategoryTotals([]);
      expect(result.totals).toEqual({});
      expect(result.total).toBe(0);
    });
  });

  describe('filterExpensesByDate', () => {
    const testExpenses: SimpleExpense[] = [
      { id: '1', title: 'Jan 2025', amount: 100, date: '2025-01-15', category: 'Food' },
      { id: '2', title: 'Mar 2025', amount: 150, date: '2025-03-10', category: 'Food' },
      { id: '3', title: 'Dec 2024', amount: 200, date: '2024-12-25', category: 'Food' },
    ];

    it('should filter by year', () => {
      const result = filterExpensesByDate(testExpenses as any, 'year', 2025);
      expect(result).toHaveLength(2);
      expect(result.map(e => e.title)).toContain('Jan 2025');
      expect(result.map(e => e.title)).toContain('Mar 2025');
    });

    it('should filter by month', () => {
      const result = filterExpensesByDate(testExpenses as any, 'month', 2025, 0); // January = 0
      expect(result).toHaveLength(1);
      expect(result[0].title).toBe('Jan 2025');
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

    it('should return year for year aggregation', () => {
      const result = getDisplayPeriodText(2025, 8, 'year', monthNames);
      expect(result).toBe('2025');
    });
  });

  describe('getPreviousPeriod', () => {
    it('should navigate to previous month', () => {
      const result = getPreviousPeriod(2025, 8, 'month'); // September
      expect(result).toEqual({ year: 2025, month: 7 }); // August
    });

    it('should navigate to previous year from January', () => {
      const result = getPreviousPeriod(2025, 0, 'month'); // January
      expect(result).toEqual({ year: 2024, month: 11 }); // December 2024
    });

    it('should navigate to previous year for year aggregation', () => {
      const result = getPreviousPeriod(2025, 8, 'year');
      expect(result).toEqual({ year: 2024, month: 8 });
    });
  });

  describe('isNextPeriodDisabled with mocked date', () => {
    beforeEach(() => {
      // Mock current date to September 19, 2025
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2025-09-19'));
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should disable for current month', () => {
      const result = isNextPeriodDisabled(2025, 8, 'month'); // September = 8
      expect(result).toBe(true);
    });

    it('should enable for past months', () => {
      const result = isNextPeriodDisabled(2025, 7, 'month'); // August = 7
      expect(result).toBe(false);
    });

    it('should disable for current year', () => {
      const result = isNextPeriodDisabled(2025, 8, 'year');
      expect(result).toBe(true);
    });

    it('should enable for past years', () => {
      const result = isNextPeriodDisabled(2024, 8, 'year');
      expect(result).toBe(false);
    });
  });

  describe('getNextPeriod with mocked date', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2025-09-19'));
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should navigate to next month if not future', () => {
      const result = getNextPeriod(2025, 7, 'month'); // August
      expect(result).toEqual({ year: 2025, month: 8 }); // September
    });

    it('should return null for current month', () => {
      const result = getNextPeriod(2025, 8, 'month'); // September (current)
      expect(result).toBeNull();
    });

    it('should navigate to next year if not future', () => {
      const result = getNextPeriod(2024, 8, 'year');
      expect(result).toEqual({ year: 2025, month: 8 });
    });

    it('should return null for current year', () => {
      const result = getNextPeriod(2025, 8, 'year');
      expect(result).toBeNull();
    });
  });
});