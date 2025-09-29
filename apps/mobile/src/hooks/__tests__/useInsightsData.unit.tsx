import React, { createRef, forwardRef, useImperativeHandle } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { useInsightsData } from '../useInsightsData';
import { useExpenseStore } from '../../store/expenseStore';
import { DEFAULT_CATEGORIES } from '../../constants/expenses';
import type { Expense, ExpenseGroup, Participant } from '../../types';

const defaultSettings = {
  theme: 'light' as const,
  currency: 'USD',
  dateFormat: 'MM/DD/YYYY',
  notifications: true,
};

type HookHandle = ReturnType<typeof useInsightsData>;

type HarnessProps = Parameters<typeof useInsightsData>[0];

const InsightsHarness = forwardRef<HookHandle, HarnessProps>((props, ref) => {
  const hookValue = useInsightsData(props);
  useImperativeHandle(ref, () => hookValue, [hookValue]);
  return null;
});
InsightsHarness.displayName = 'InsightsHarness';

const participants: Participant[] = [
  { id: 'user-1', name: 'Alice' },
  { id: 'user-2', name: 'Bob' },
];

const group: ExpenseGroup = {
  id: 'group-1',
  name: 'Cycling Club',
  participants,
  createdAt: '2025-01-01T00:00:00.000Z',
};

const personalExpenses: Expense[] = [
  {
    id: 'exp-1',
    title: 'Coffee',
    amount: 5,
    date: '2025-01-02',
    category: 'Food & Dining',
    paidBy: 'user-1',
  },
  {
    id: 'exp-2',
    title: 'Metro',
    amount: 8,
    date: '2025-01-15',
    category: 'Transportation',
    paidBy: 'user-1',
  },
  {
    id: 'exp-3',
    title: 'Dinner',
    amount: 20,
    date: '2024-12-31',
    category: 'Food & Dining',
    paidBy: 'user-1',
  },
];

const groupExpenses: Expense[] = [
  {
    id: 'exp-4',
    title: 'Snacks',
    amount: 30,
    date: '2025-01-10',
    category: 'Food & Dining',
    groupId: 'group-1',
    paidBy: 'user-2',
    splitBetween: ['user-1', 'user-2'],
    participants,
  },
];

const resetStore = () => {
  useExpenseStore.setState({
    expenses: [],
    groups: [],
    participants: [],
    categories: DEFAULT_CATEGORIES.map((category) => ({ ...category })),
    user: null,
    settings: { ...defaultSettings },
    userSettings: null,
    internalUserId: null,
  });
};

describe('useInsightsData', () => {
  beforeEach(() => {
    resetStore();
  });

  it('computes chart data for personal context and navigates periods', () => {
    useExpenseStore.setState((state) => ({
      ...state,
      expenses: personalExpenses,
      internalUserId: 'user-1',
    }));

    const ref = createRef<HookHandle>();

    act(() => {
      TestRenderer.create(
        <InsightsHarness
          ref={ref}
          contextType='personal'
          contextId='user-1'
          initialDate={new Date('2025-01-01')}
        />,
      );
    });

    const chartCategories = ref.current!.chartData.map(
      (point) => point.category,
    );
    expect(chartCategories).toContain('Food & Dining');
    expect(chartCategories).toContain('Transportation');
    expect(ref.current!.screenTitle).toBe('Personal Expense Insights');
    expect(ref.current!.displayPeriodText).toBe('January 2025');

    act(() => {
      ref.current!.handlePreviousPeriod();
    });
    expect(ref.current!.selectedMonth).toBe(11); // December
    expect(ref.current!.selectedYear).toBe(2024);

    act(() => {
      ref.current!.handleNextPeriod();
    });
    expect(ref.current!.selectedYear).toBe(2025);
    expect(ref.current!.selectedMonth).toBe(0);

    act(() => {
      ref.current!.setAggregation('year');
    });
    expect(ref.current!.aggregation).toBe('year');
  });

  it('filters expenses for group context and respects available participants', () => {
    useExpenseStore.setState((state) => ({
      ...state,
      expenses: [...personalExpenses, ...groupExpenses],
      groups: [group],
      participants,
      internalUserId: 'user-1',
    }));

    const ref = createRef<HookHandle>();

    act(() => {
      TestRenderer.create(
        <InsightsHarness
          ref={ref}
          contextType='group'
          contextId='group-1'
          initialDate={new Date('2025-01-01')}
        />,
      );
    });

    expect(ref.current!.screenTitle).toBe('Cycling Club Insights');
    expect(ref.current!.chartData).toHaveLength(1);
    expect(ref.current!.chartData[0].absoluteValue).toBe(30);
  });
});
