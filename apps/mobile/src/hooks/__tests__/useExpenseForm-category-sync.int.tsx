import { renderHook, act, waitFor } from '@testing-library/react-native';
import { useExpenseForm } from '../useExpenseForm';
import { useExpenseStore } from '../../store/expenseStore';
import { useCategoryStore } from '../../store/features/categoryStore';

// Mock expo-router
jest.mock('expo-router', () => ({
  router: {
    back: jest.fn(),
  },
}));

describe('useExpenseForm - Category Sync Integration', () => {
  const TEST_CATEGORIES = [
    { id: 'food', name: 'Food', color: '#FF6B6B' },
    { id: 'transport', name: 'Transport', color: '#4ECDC4' },
    { id: 'other', name: 'Other', color: '#95E1D3' },
  ];

  beforeEach(() => {
    // Reset category store first (source of truth)
    useCategoryStore.setState({
      categories: TEST_CATEGORIES,
    });

    // Give time for subscription to propagate
    const initialState = useExpenseStore.getState();
    useExpenseStore.setState({
      ...initialState,
      expenses: [],
      groups: [],
      participants: [],
      categories: TEST_CATEGORIES,
      userSettings: { name: 'Test User' },
      internalUserId: 'test-user-id',
    });
  });

  it('should reflect categories from store', () => {
    const { result } = renderHook(() =>
      useExpenseForm({ editingExpense: null }),
    );

    expect(result.current.categories).toHaveLength(3);
    expect(result.current.categories.map((c) => c.name)).toEqual([
      'Food',
      'Transport',
      'Other',
    ]);
  });

  it('should update when category is deleted from store', async () => {
    const { result, rerender } = renderHook(() =>
      useExpenseForm({ editingExpense: null }),
    );

    // Initial state: 3 categories
    expect(result.current.categories).toHaveLength(3);
    expect(
      result.current.categories.find((c) => c.name === 'Transport'),
    ).toBeDefined();

    // Delete "Transport" category from category store (source of truth)
    act(() => {
      useCategoryStore.getState().deleteCategory('transport');
    });

    // Wait for store subscription to propagate and re-render
    await waitFor(() => {
      expect(result.current.categories).toHaveLength(2);
    });

    // Assert: "Transport" is no longer available
    expect(
      result.current.categories.find((c) => c.name === 'Transport'),
    ).toBeUndefined();
    expect(result.current.categories.map((c) => c.name)).toEqual([
      'Food',
      'Other',
    ]);
  });

  it('should update when category is added to store', async () => {
    const { result } = renderHook(() =>
      useExpenseForm({ editingExpense: null }),
    );

    // Initial state: 3 categories
    expect(result.current.categories).toHaveLength(3);

    // Add new category to category store (source of truth)
    act(() => {
      useCategoryStore.getState().addCategory({
        name: 'Entertainment',
        color: '#FFD93D',
      });
    });

    // Wait for store subscription to propagate and re-render
    await waitFor(() => {
      expect(result.current.categories).toHaveLength(4);
    });

    // Assert: New category is available
    expect(
      result.current.categories.find((c) => c.name === 'Entertainment'),
    ).toBeDefined();
  });

  it('should use first available category as default when form is reset', () => {
    const { result } = renderHook(() =>
      useExpenseForm({ editingExpense: null }),
    );

    // Default category should be the first one
    expect(result.current.formState.category).toBe('Food');
  });

  it('should fallback to "Other" if categories array is empty', () => {
    // Set store to have no categories (edge case)
    act(() => {
      useExpenseStore.setState({
        categories: [],
      });
    });

    const { result } = renderHook(() =>
      useExpenseForm({ editingExpense: null }),
    );

    // Should fallback to "Other"
    expect(result.current.formState.category).toBe('Other');
  });

  it('should reset to first category when editingExpense becomes null', () => {
    const mockExpense = {
      id: 'exp-1',
      title: 'Test Expense',
      amount: 50,
      date: '2025-09-30',
      category: 'Transport',
      caption: '',
    };

    const { result, rerender } = renderHook(
      ({ editingExpense }) => useExpenseForm({ editingExpense }),
      {
        initialProps: { editingExpense: mockExpense },
      },
    );

    // Initially editing expense with "Transport" category
    expect(result.current.formState.category).toBe('Transport');

    // Stop editing (set to null)
    rerender({ editingExpense: null });

    // Should reset to first category
    expect(result.current.formState.category).toBe('Food');
  });

  it('should preserve category in form state even if that category is deleted after editing starts', async () => {
    const mockExpense = {
      id: 'exp-1',
      title: 'Test Expense',
      amount: 50,
      date: '2025-09-30',
      category: 'Transport',
      caption: '',
    };

    const { result } = renderHook(() =>
      useExpenseForm({ editingExpense: mockExpense }),
    );

    // Editing expense with "Transport" category
    expect(result.current.formState.category).toBe('Transport');

    // Delete "Transport" category from category store
    act(() => {
      useCategoryStore.getState().deleteCategory('transport');
    });

    // Wait for store subscription to propagate
    await waitFor(() => {
      expect(
        result.current.categories.find((c) => c.name === 'Transport'),
      ).toBeUndefined();
    });

    // Form state should still have "Transport" (historical data preserved)
    expect(result.current.formState.category).toBe('Transport');
  });
});
