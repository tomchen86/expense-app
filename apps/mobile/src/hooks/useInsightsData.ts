import { useState, useMemo, useEffect as _useEffect } from 'react';
import { useExpenseStore } from '../store/expenseStore';
import {
  generateCategoryChartData,
  getRelevantExpenses,
  filterExpensesByDate,
  isNextPeriodDisabled,
  getDisplayPeriodText,
  getPreviousPeriod,
  getNextPeriod,
  ChartDataPoint,
} from '../utils/calculations/insightCalculations';
import { ExpenseGroup as _ExpenseGroup } from '../types';
import { calculateUserShareMinor } from '../utils/expenseCalculations';
import {
  getExpenseAmountMinor,
  getExpenseSpaceId,
} from '../utils/expenseDomain';

interface UseInsightsDataProps {
  contextType: 'personal' | 'group';
  contextId: string;
  initialDate?: Date;
}

interface UseInsightsDataReturn {
  // Data
  chartData: ChartDataPoint[];
  screenTitle: string;

  // Date/Period State
  aggregation: 'month' | 'year';
  selectedYear: number;
  selectedMonth: number;
  displayPeriodText: string;
  isNextDisabled: boolean;

  // Date Picker State
  showDatePickers: boolean;
  availableYears: number[];
  monthNames: string[];

  // Actions
  setAggregation: (aggregation: 'month' | 'year') => void;
  handlePreviousPeriod: () => void;
  handleNextPeriod: () => void;
  setShowDatePickers: (show: boolean) => void;
  setSelectedYear: (year: number) => void;
  setSelectedMonth: (month: number) => void;
}

export const useInsightsData = ({
  contextType,
  contextId,
  initialDate,
}: UseInsightsDataProps): UseInsightsDataReturn => {
  // Store data
  const allExpenses = useExpenseStore((state) => state.expenses);
  const internalUserId = useExpenseStore((state) => state.internalUserId);
  const personalParticipantId = useExpenseStore(
    (state) => state.personalParticipantId,
  );
  const personalSpaceId = useExpenseStore((state) => state.personalSpaceId);
  const participants = useExpenseStore((state) => state.participants);
  const groups = useExpenseStore((state) => state.groups);
  const appCategories = useExpenseStore((state) => state.categories);

  // State
  const [aggregation, setAggregation] = useState<'month' | 'year'>('month');
  const [selectedYear, setSelectedYear] = useState<number>(
    initialDate ? initialDate.getFullYear() : new Date().getFullYear(),
  );
  const [selectedMonth, setSelectedMonth] = useState<number>(
    initialDate ? initialDate.getMonth() : new Date().getMonth(),
  );
  const [showDatePickers, setShowDatePickers] = useState(false);

  // Constants
  const availableYears = useMemo(() => {
    const currentYear = new Date().getFullYear();
    const years = [];
    for (let i = currentYear - 5; i <= currentYear + 5; i++) {
      years.push(i);
    }
    return years;
  }, []);

  const monthNames = useMemo(
    () => [
      'January',
      'February',
      'March',
      'April',
      'May',
      'June',
      'July',
      'August',
      'September',
      'October',
      'November',
      'December',
    ],
    [],
  );

  // Screen title
  const screenTitle = useMemo(() => {
    if (contextType === 'group') {
      const group = groups.find((g) => g.id === contextId);
      return group ? `${group.name} Insights` : 'Group Insights';
    }
    return 'Personal Expense Insights';
  }, [contextType, contextId, groups]);

  // Display period text
  const displayPeriodText = useMemo(() => {
    return getDisplayPeriodText(
      selectedYear,
      selectedMonth,
      aggregation,
      monthNames,
    );
  }, [selectedMonth, selectedYear, aggregation, monthNames]);

  // Check if next is disabled
  const isNextDisabled = useMemo(() => {
    return isNextPeriodDisabled(selectedYear, selectedMonth, aggregation);
  }, [selectedYear, selectedMonth, aggregation]);

  // Get filtered expenses
  const filteredExpenses = useMemo(() => {
    const personalParticipantIds = Array.from(
      new Set([
        personalParticipantId,
        ...participants
          .filter((participant) => participant.userId === internalUserId)
          .map((participant) => participant.id),
      ]),
    );
    const relevantExpenses = getRelevantExpenses(
      allExpenses,
      contextType,
      contextId,
      personalParticipantId,
      personalSpaceId,
      personalParticipantIds,
    );

    return filterExpensesByDate(
      relevantExpenses,
      aggregation,
      selectedYear,
      selectedMonth,
    );
  }, [
    allExpenses,
    contextType,
    contextId,
    internalUserId,
    personalParticipantId,
    personalSpaceId,
    participants,
    aggregation,
    selectedYear,
    selectedMonth,
  ]);

  // Generate chart data
  const chartData = useMemo(() => {
    return generateCategoryChartData(
      filteredExpenses,
      appCategories,
      '#808080',
      contextType === 'personal'
        ? (expense) => {
            if (
              expense.spaceKind === 'personal' &&
              getExpenseSpaceId(expense) === personalSpaceId
            ) {
              return getExpenseAmountMinor(expense);
            }
            const participantIds = Array.from(
              new Set([
                personalParticipantId,
                ...participants
                  .filter(
                    (participant) => participant.userId === internalUserId,
                  )
                  .map((participant) => participant.id),
              ]),
            );
            return participantIds.reduce(
              (sum, participantId) =>
                sum + calculateUserShareMinor(expense, participantId),
              0,
            );
          }
        : undefined,
    );
  }, [
    filteredExpenses,
    appCategories,
    contextType,
    internalUserId,
    participants,
    personalParticipantId,
    personalSpaceId,
  ]);

  // Period navigation handlers
  const handlePreviousPeriod = () => {
    const previous = getPreviousPeriod(
      selectedYear,
      selectedMonth,
      aggregation,
    );
    setSelectedYear(previous.year);
    setSelectedMonth(previous.month);
  };

  const handleNextPeriod = () => {
    const next = getNextPeriod(selectedYear, selectedMonth, aggregation);
    if (next) {
      setSelectedYear(next.year);
      setSelectedMonth(next.month);
    }
  };

  return {
    // Data
    chartData,
    screenTitle,

    // Date/Period State
    aggregation,
    selectedYear,
    selectedMonth,
    displayPeriodText,
    isNextDisabled,

    // Date Picker State
    showDatePickers,
    availableYears,
    monthNames,

    // Actions
    setAggregation,
    handlePreviousPeriod,
    handleNextPeriod,
    setShowDatePickers,
    setSelectedYear,
    setSelectedMonth,
  };
};
