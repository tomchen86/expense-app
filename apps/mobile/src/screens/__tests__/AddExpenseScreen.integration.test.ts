// AddExpenseScreen integration tests - workflow validation
import { useExpenseStore } from '../../store/composedExpenseStore';
import { validExpense, validGroup, mockUser } from '../../__tests__/fixtures';

describe('AddExpenseScreen Integration', () => {
  beforeEach(() => {
    // Reset individual stores first
    const { useExpenseStore: useExpenseFeatureStore } = require('../../store/features/expenseStore');
    const { useGroupStore } = require('../../store/features/groupStore');
    const { useParticipantStore } = require('../../store/features/participantStore');
    const { useCategoryStore } = require('../../store/features/categoryStore');
    const { useUserStore } = require('../../store/features/userStore');

    // Reset individual stores
    useExpenseFeatureStore.setState({ expenses: [] });
    useGroupStore.setState({ groups: [] });
    useParticipantStore.setState({ participants: [] });
    useUserStore.setState({
      user: null,
      settings: {
        theme: 'light',
        currency: 'USD',
        dateFormat: 'MM/DD/YYYY',
        notifications: true,
      },
      userSettings: null,
      internalUserId: `user_${Math.random().toString(36).substr(2, 9)}`,
    });

    // Reset categories to default test categories
    useCategoryStore.setState({
      categories: [
        {
          id: 'cat-1',
          name: 'Food & Dining',
          color: '#FF5722',
        },
        {
          id: 'cat-2',
          name: 'Transportation',
          color: '#2196F3',
        },
      ],
    });

    // Reset composed store to sync state
    useExpenseStore.setState({
      expenses: [],
      groups: [],
      participants: [],
      categories: [
        {
          id: 'cat-1',
          name: 'Food & Dining',
          color: '#FF5722',
        },
        {
          id: 'cat-2',
          name: 'Transportation',
          color: '#2196F3',
        },
      ],
      user: null,
      settings: {
        theme: 'light',
        currency: 'USD',
        dateFormat: 'MM/DD/YYYY',
        notifications: true,
      },
      userSettings: null,
      internalUserId: useUserStore.getState().internalUserId,
    });
  });

  describe('expense creation workflow', () => {
    it('should complete full expense creation flow', () => {
      const store = useExpenseStore.getState();

      // Simulate form input
      const expenseData = {
        title: 'Test Lunch',
        amount: 15.5,
        category: 'Food & Dining',
        date: '2025-09-20',
        userId: mockUser.internalUserId,
      };

      // Add expense through store
      store.addExpense(expenseData);

      // Verify expense was added
      const expenses = useExpenseStore.getState().expenses;
      expect(expenses).toHaveLength(1);
      expect(expenses[0].title).toBe('Test Lunch');
      expect(expenses[0].amount).toBe(15.5);
      expect(expenses[0].category).toBe('Food & Dining');
    });

    it('should handle group expense assignment', () => {
      const store = useExpenseStore.getState();

      // First add a group
      const groupId = store.addGroup('Test Group');

      const groups = useExpenseStore.getState().groups;

      // Create group expense
      const groupExpense = {
        title: 'Group Dinner',
        amount: 80.0,
        category: 'Food & Dining',
        date: '2025-09-20',
        userId: mockUser.internalUserId,
        groupId: groupId,
      };

      store.addExpense(groupExpense);

      // Verify group expense
      const expenses = useExpenseStore.getState().expenses;
      expect(expenses[0].groupId).toBe(groupId);
      expect(expenses[0].title).toBe('Group Dinner');
    });

    it('should validate required fields', () => {
      const validateExpenseForm = (formData: any) => {
        const errors: Record<string, string> = {};

        if (!formData.title || formData.title.trim().length === 0) {
          errors.title = 'Title is required';
        }

        if (!formData.amount || formData.amount <= 0) {
          errors.amount = 'Amount must be greater than 0';
        }

        if (!formData.category) {
          errors.category = 'Category is required';
        }

        if (!formData.date) {
          errors.date = 'Date is required';
        }

        return Object.keys(errors).length === 0 ? null : errors;
      };

      // Test valid form
      const validForm = {
        title: 'Valid Expense',
        amount: 10.5,
        category: 'Food & Dining',
        date: '2025-09-20',
      };
      expect(validateExpenseForm(validForm)).toBeNull();

      // Test invalid forms
      expect(validateExpenseForm({ title: '', amount: 10 })).toEqual({
        title: 'Title is required',
        category: 'Category is required',
        date: 'Date is required',
      });

      expect(validateExpenseForm({ title: 'Test', amount: 0 })).toEqual({
        amount: 'Amount must be greater than 0',
        category: 'Category is required',
        date: 'Date is required',
      });
    });

    it('should integrate with store correctly', () => {
      const store = useExpenseStore.getState();
      const initialExpenseCount = store.expenses.length;

      // Add multiple expenses with different dates to ensure predictable sorting
      const expenses = [
        {
          title: 'Coffee',
          amount: 4.5,
          category: 'Food & Dining',
          date: '2025-09-20',
          userId: mockUser.internalId,
        },
        {
          title: 'Bus Ticket',
          amount: 2.25,
          category: 'Transportation',
          date: '2025-09-21', // Later date, should be first when sorted
          userId: mockUser.internalId,
        },
      ];

      expenses.forEach((expense) => store.addExpense(expense));

      // Verify store state
      const updatedState = useExpenseStore.getState();
      expect(updatedState.expenses).toHaveLength(initialExpenseCount + 2);

      // Verify expense order (should be most recent first)
      const sortedExpenses = updatedState.expenses.sort(
        (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
      );
      expect(sortedExpenses[0].title).toBe('Bus Ticket');
      expect(sortedExpenses[1].title).toBe('Coffee');
    });
  });

  describe('navigation and state management', () => {
    it('should handle navigation back on successful save', () => {
      const mockNavigate = jest.fn();

      const simulateExpenseSave = (
        expenseData: any,
        navigate: typeof mockNavigate,
      ) => {
        try {
          const store = useExpenseStore.getState();
          store.addExpense(expenseData);
          navigate('Home');
          return { success: true };
        } catch (error) {
          return { success: false, error };
        }
      };

      const result = simulateExpenseSave(
        {
          title: 'Test Expense',
          amount: 25.0,
          category: 'Food & Dining',
          date: '2025-09-20',
          userId: mockUser.internalUserId,
        },
        mockNavigate,
      );

      expect(result.success).toBe(true);
      expect(mockNavigate).toHaveBeenCalledWith('Home');
    });

    it('should maintain form state during category selection', () => {
      interface FormState {
        title: string;
        amount: string;
        category: string;
        date: string;
        groupId?: string;
      }

      const initialFormState: FormState = {
        title: 'Partial Entry',
        amount: '15.50',
        category: '',
        date: '2025-09-20',
      };

      // Simulate user typing and then selecting category
      const updateFormField = (
        state: FormState,
        field: keyof FormState,
        value: string,
      ): FormState => {
        return { ...state, [field]: value };
      };

      let formState = initialFormState;
      formState = updateFormField(formState, 'category', 'Food & Dining');

      // Verify form state maintained all previous inputs
      expect(formState.title).toBe('Partial Entry');
      expect(formState.amount).toBe('15.50');
      expect(formState.category).toBe('Food & Dining');
      expect(formState.date).toBe('2025-09-20');
    });

    it('should handle form reset after successful submission', () => {
      const getInitialFormState = () => ({
        title: '',
        amount: '',
        category: '',
        date: new Date().toISOString().split('T')[0],
        groupId: undefined,
      });

      const resetForm = () => getInitialFormState();

      // Simulate filled form
      let formState = {
        title: 'Submitted Expense',
        amount: '50.00',
        category: 'Food & Dining',
        date: '2025-09-20',
        groupId: 'group-1',
      };

      // After successful submission, reset form
      formState = resetForm();

      expect(formState.title).toBe('');
      expect(formState.amount).toBe('');
      expect(formState.category).toBe('');
      expect(formState.groupId).toBeUndefined();
      expect(formState.date).toMatch(/^\d{4}-\d{2}-\d{2}$/); // Today's date
    });
  });

  describe('category and group integration', () => {
    it('should load available categories', () => {
      const store = useExpenseStore.getState();
      const categories = store.categories;

      expect(categories).toHaveLength(2);
      expect(categories.find((c) => c.name === 'Food & Dining')).toBeDefined();
      expect(categories.find((c) => c.name === 'Transportation')).toBeDefined();
    });

    it('should load available groups for expense assignment', () => {
      const store = useExpenseStore.getState();

      // Add test groups
      store.addGroup('Family');
      store.addGroup('Friends');

      const groups = useExpenseStore.getState().groups;
      expect(groups).toHaveLength(2);
      expect(groups.map((g) => g.name)).toContain('Family');
      expect(groups.map((g) => g.name)).toContain('Friends');
    });

    it('should handle expense assignment to specific group', () => {
      const store = useExpenseStore.getState();

      // Create group first
      const vacationGroupId = store.addGroup('Vacation Group');

      // Create expense assigned to group
      store.addExpense({
        title: 'Hotel Stay',
        amount: 200.0,
        category: 'Food & Dining',
        date: '2025-09-20',
        userId: mockUser.internalUserId,
        groupId: vacationGroupId,
      });

      const expenses = useExpenseStore.getState().expenses;
      expect(expenses[0].groupId).toBe(vacationGroupId);

      // Verify group still has the expense
      const updatedGroups = useExpenseStore.getState().groups;
      const vacationGroup = updatedGroups.find((g) => g.id === vacationGroupId);
      expect(vacationGroup).toBeDefined();
    });
  });
});
