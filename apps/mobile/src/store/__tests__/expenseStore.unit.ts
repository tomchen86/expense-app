import { useExpenseStore } from '../features/expenseStore';
import { mockExpenses, createMockExpense } from '../../__tests__/fixtures';

describe('ExpenseStore', () => {
  let randomSpy: jest.SpiedFunction<typeof Math.random>;

  beforeEach(() => {
    // Reset store state and provide deterministic IDs
    useExpenseStore.setState({ expenses: [] });
    let counter = 1;
    randomSpy = jest.spyOn(Math, 'random').mockImplementation(() => {
      const value = counter / 1000;
      counter += 1;
      return value;
    });
  });

  afterEach(() => {
    randomSpy.mockRestore();
  });

  describe('addExpense', () => {
    it('should add expense with generated ID', () => {
      const expense = createMockExpense({
        title: 'Test Expense',
        amount: 25.5,
        date: '2025-09-19',
      });

      useExpenseStore.getState().addExpense(expense);
      const expenses = useExpenseStore.getState().expenses;

      const { id: _id, ...expectedFields } = expense;

      expect(expenses).toHaveLength(1);
      expect(expenses[0]).toMatchObject({
        ...expectedFields,
        id: expect.any(String),
      });
    });

    it('should sort expenses by date descending (newest first)', () => {
      const expense1 = createMockExpense({
        title: 'Older Expense',
        date: '2025-09-17',
      });
      const expense2 = createMockExpense({
        title: 'Newer Expense',
        date: '2025-09-19',
      });

      useExpenseStore.getState().addExpense(expense1);
      useExpenseStore.getState().addExpense(expense2);

      const expenses = useExpenseStore.getState().expenses;
      expect(expenses[0].title).toBe('Newer Expense');
      expect(expenses[1].title).toBe('Older Expense');
    });

    it('should handle expenses with same date', () => {
      const expense1 = createMockExpense({
        title: 'First Expense',
        date: '2025-09-19',
      });
      const expense2 = createMockExpense({
        title: 'Second Expense',
        date: '2025-09-19',
      });

      useExpenseStore.getState().addExpense(expense1);
      useExpenseStore.getState().addExpense(expense2);

      const expenses = useExpenseStore.getState().expenses;
      expect(expenses).toHaveLength(2);
      // Both should be present, order may vary for same date
      expect(expenses.map((e) => e.title)).toContain('First Expense');
      expect(expenses.map((e) => e.title)).toContain('Second Expense');
    });

    it('should handle group expenses', () => {
      const groupExpense = createMockExpense({
        title: 'Group Lunch',
        amount: 50.0,
        groupId: 'group-1',
        paidBy: 'user-1',
        splitBetween: ['user-1', 'user-2'],
      });

      useExpenseStore.getState().addExpense(groupExpense);
      const expenses = useExpenseStore.getState().expenses;

      const { id: _id, ...expectedGroupFields } = groupExpense;

      expect(expenses[0]).toMatchObject({
        ...expectedGroupFields,
        id: expect.any(String),
      });
      expect(expenses[0].groupId).toBe('group-1');
      expect(expenses[0].paidBy).toBe('user-1');
      expect(expenses[0].splitBetween).toEqual(['user-1', 'user-2']);
    });
  });

  describe('updateExpense', () => {
    it('advances only local revision while preserving the last server version', () => {
      const expense = createMockExpense({
        title: 'Offline edit',
        amountMinor: 2500,
        currency: 'USD',
        categoryId: 'a4d1ab87-d102-4795-b9fa-706bc9e13975',
        spaceId: 'bb7178d8-09e8-43ac-ab4c-c6a6a2ef9ddc',
        spaceKind: 'shared',
        payments: [
          {
            participantId: '8f785006-c58a-47f9-84ac-d67620969ad0',
            amountMinor: 2500,
          },
        ],
        shares: [
          {
            participantId: '8f785006-c58a-47f9-84ac-d67620969ad0',
            amountMinor: 2500,
          },
        ],
      });
      useExpenseStore.getState().addExpense(expense);
      const created = useExpenseStore.getState().expenses[0];
      useExpenseStore.setState({
        expenses: [
          {
            ...created,
            sync: {
              ...created.sync!,
              serverVersion: 7,
              localRevision: 0,
              status: 'synced',
            },
          },
        ],
      });

      useExpenseStore.getState().updateExpense({
        ...useExpenseStore.getState().expenses[0],
        title: 'Edited once',
      });
      useExpenseStore.getState().updateExpense({
        ...useExpenseStore.getState().expenses[0],
        title: 'Edited twice',
      });

      expect(useExpenseStore.getState().expenses[0].sync).toMatchObject({
        serverVersion: 7,
        localRevision: 2,
        status: 'pending',
      });
      expect(useExpenseStore.getState().expenses[0].categoryId).toBe(
        'a4d1ab87-d102-4795-b9fa-706bc9e13975',
      );
    });
    it('should update existing expense', () => {
      const expense = createMockExpense({
        title: 'Original Title',
        amount: 25.0,
      });

      useExpenseStore.getState().addExpense(expense);
      const addedExpense = useExpenseStore.getState().expenses[0];

      const updatedExpense = {
        ...addedExpense,
        title: 'Updated Title',
        amount: 30.0,
      };

      useExpenseStore.getState().updateExpense(updatedExpense);
      const expenses = useExpenseStore.getState().expenses;

      expect(expenses).toHaveLength(1);
      expect(expenses[0].title).toBe('Updated Title');
      expect(expenses[0].amount).toBe(30.0);
      expect(expenses[0].id).toBe(addedExpense.id);
    });

    it('should maintain sort order after update', () => {
      const expense1 = createMockExpense({
        title: 'Expense 1',
        date: '2025-09-17',
      });
      const expense2 = createMockExpense({
        title: 'Expense 2',
        date: '2025-09-19',
      });

      useExpenseStore.getState().addExpense(expense1);
      useExpenseStore.getState().addExpense(expense2);

      const expenses = useExpenseStore.getState().expenses;
      const olderExpense = expenses.find((e) => e.title === 'Expense 1');

      // Update older expense to newer date
      const updatedExpense = {
        ...olderExpense!,
        date: '2025-09-20',
      };

      useExpenseStore.getState().updateExpense(updatedExpense);
      const updatedExpenses = useExpenseStore.getState().expenses;

      // Should now be first (newest)
      expect(updatedExpenses[0].title).toBe('Expense 1');
      expect(updatedExpenses[0].date).toBe('2025-09-20');
    });

    it('should not affect other expenses', () => {
      const expense1 = createMockExpense({ title: 'Expense 1' });
      const expense2 = createMockExpense({ title: 'Expense 2' });

      useExpenseStore.getState().addExpense(expense1);
      useExpenseStore.getState().addExpense(expense2);

      const expenses = useExpenseStore.getState().expenses;
      const targetExpense = expenses.find((e) => e.title === 'Expense 1');

      useExpenseStore.getState().updateExpense({
        ...targetExpense!,
        title: 'Updated Expense 1',
      });

      const updatedExpenses = useExpenseStore.getState().expenses;
      expect(updatedExpenses).toHaveLength(2);
      expect(
        updatedExpenses.find((e) => e.title === 'Updated Expense 1'),
      ).toBeDefined();
      expect(
        updatedExpenses.find((e) => e.title === 'Expense 2'),
      ).toBeDefined();
    });
  });

  describe('deleteExpense', () => {
    it('should remove expense by ID', () => {
      const expense = createMockExpense({ title: 'To Delete' });

      useExpenseStore.getState().addExpense(expense);
      const addedExpense = useExpenseStore.getState().expenses[0];

      useExpenseStore.getState().deleteExpense(addedExpense.id);
      const expenses = useExpenseStore.getState().expenses;

      expect(expenses).toHaveLength(0);
    });

    it('should not affect other expenses when deleting', () => {
      const expense1 = createMockExpense({ title: 'Keep This' });
      const expense2 = createMockExpense({ title: 'Delete This' });

      useExpenseStore.getState().addExpense(expense1);
      useExpenseStore.getState().addExpense(expense2);

      const expenses = useExpenseStore.getState().expenses;
      const toDelete = expenses.find((e) => e.title === 'Delete This');

      useExpenseStore.getState().deleteExpense(toDelete!.id);
      const remainingExpenses = useExpenseStore.getState().expenses;

      expect(remainingExpenses).toHaveLength(1);
      expect(remainingExpenses[0].title).toBe('Keep This');
    });

    it('should handle deleting non-existent expense gracefully', () => {
      const expense = createMockExpense({ title: 'Test' });
      useExpenseStore.getState().addExpense(expense);

      useExpenseStore.getState().deleteExpense('non-existent-id');
      const expenses = useExpenseStore.getState().expenses;

      expect(expenses).toHaveLength(1);
      expect(expenses[0].title).toBe('Test');
    });
  });

  describe('getExpenseById', () => {
    it('should return expense by ID', () => {
      const expense = createMockExpense({ title: 'Find Me' });
      useExpenseStore.getState().addExpense(expense);

      const addedExpense = useExpenseStore.getState().expenses[0];
      const foundExpense = useExpenseStore
        .getState()
        .getExpenseById(addedExpense.id);

      expect(foundExpense).toBeDefined();
      expect(foundExpense!.title).toBe('Find Me');
      expect(foundExpense!.id).toBe(addedExpense.id);
    });

    it('should return undefined for non-existent ID', () => {
      const foundExpense = useExpenseStore
        .getState()
        .getExpenseById('non-existent');
      expect(foundExpense).toBeUndefined();
    });
  });

  describe('migrateOrphanedExpenses', () => {
    it('should migrate orphaned personal expenses without a fake group ID', () => {
      const orphanedExpense = createMockExpense({
        title: 'Orphaned',
        groupId: undefined,
        paidBy: undefined,
      });
      const normalExpense = createMockExpense({
        title: 'Normal',
        groupId: 'group-1',
        paidBy: 'user-1',
      });

      useExpenseStore.getState().addExpense(orphanedExpense);
      useExpenseStore.getState().addExpense(normalExpense);

      useExpenseStore.getState().migrateOrphanedExpenses('internal-user-1');
      const expenses = useExpenseStore.getState().expenses;

      const migratedExpense = expenses.find((e) => e.title === 'Orphaned');
      const untouchedExpense = expenses.find((e) => e.title === 'Normal');

      expect(migratedExpense).toMatchObject({
        amountMinor: 2500,
        currency: 'USD',
        spaceId: 'personal_internal-user-1',
        spaceKind: 'personal',
        payments: [{ participantId: 'internal-user-1', amountMinor: 2500 }],
        shares: [{ participantId: 'internal-user-1', amountMinor: 2500 }],
      });
      expect(migratedExpense!.groupId).toBeUndefined();
      expect(untouchedExpense!.groupId).toBe('group-1');
      expect(untouchedExpense!.paidBy).toBe('user-1');
    });

    it('should not migrate expenses with existing groupId or paidBy', () => {
      const expenseWithGroup = createMockExpense({
        title: 'Has Group',
        groupId: 'group-1',
        paidBy: undefined,
      });
      const expenseWithPaidBy = createMockExpense({
        title: 'Has PaidBy',
        groupId: undefined,
        paidBy: 'user-1',
      });

      useExpenseStore.getState().addExpense(expenseWithGroup);
      useExpenseStore.getState().addExpense(expenseWithPaidBy);

      useExpenseStore.getState().migrateOrphanedExpenses('internal-user-1');
      const expenses = useExpenseStore.getState().expenses;

      const groupExpense = expenses.find((e) => e.title === 'Has Group');
      const paidByExpense = expenses.find((e) => e.title === 'Has PaidBy');

      expect(groupExpense!.groupId).toBe('group-1');
      expect(groupExpense!.paidBy).toBeUndefined();
      expect(paidByExpense!.groupId).toBeUndefined();
      expect(paidByExpense!.paidBy).toBe('user-1');
    });
  });

  describe('removeExpensesForGroup', () => {
    it('should retain historical space references when a group is removed', () => {
      const groupExpense1 = createMockExpense({
        title: 'Group Expense 1',
        groupId: 'group-1',
      });
      const groupExpense2 = createMockExpense({
        title: 'Group Expense 2',
        groupId: 'group-1',
      });
      const otherExpense = createMockExpense({
        title: 'Other Group',
        groupId: 'group-2',
      });

      useExpenseStore.getState().addExpense(groupExpense1);
      useExpenseStore.getState().addExpense(groupExpense2);
      useExpenseStore.getState().addExpense(otherExpense);

      useExpenseStore.getState().removeExpensesForGroup('group-1');
      const expenses = useExpenseStore.getState().expenses;

      const updatedExpense1 = expenses.find(
        (e) => e.title === 'Group Expense 1',
      );
      const updatedExpense2 = expenses.find(
        (e) => e.title === 'Group Expense 2',
      );
      const untouchedExpense = expenses.find((e) => e.title === 'Other Group');

      expect(updatedExpense1!.groupId).toBe('group-1');
      expect(updatedExpense2!.groupId).toBe('group-1');
      expect(untouchedExpense!.groupId).toBe('group-2');
    });
  });

  describe('updateExpensesForParticipantRemoval', () => {
    it('should retain historical allocations when a participant is removed', () => {
      const expense = createMockExpense({
        title: 'Participant Expense',
        paidBy: 'user-1',
        splitBetween: ['user-1', 'user-2', 'user-3'],
      });

      useExpenseStore.getState().addExpense(expense);
      useExpenseStore.getState().updateExpensesForParticipantRemoval('user-1');

      const expenses = useExpenseStore.getState().expenses;
      const updatedExpense = expenses[0];

      expect(updatedExpense.paidBy).toBe('user-1');
      expect(updatedExpense.splitBetween).toEqual([
        'user-1',
        'user-2',
        'user-3',
      ]);
    });

    it('should handle undefined splitBetween gracefully', () => {
      const expense = createMockExpense({
        title: 'No Split',
        paidBy: 'user-1',
        splitBetween: undefined,
      });

      useExpenseStore.getState().addExpense(expense);
      useExpenseStore.getState().updateExpensesForParticipantRemoval('user-1');

      const expenses = useExpenseStore.getState().expenses;
      const updatedExpense = expenses[0];

      expect(updatedExpense.paidBy).toBe('user-1');
      expect(updatedExpense.splitBetween).toBeUndefined();
    });

    it('should not affect expenses where participant is not involved', () => {
      const expense = createMockExpense({
        title: 'Unrelated',
        paidBy: 'user-2',
        splitBetween: ['user-2', 'user-3'],
      });

      useExpenseStore.getState().addExpense(expense);
      useExpenseStore.getState().updateExpensesForParticipantRemoval('user-1');

      const expenses = useExpenseStore.getState().expenses;
      const unchangedExpense = expenses[0];

      expect(unchangedExpense.paidBy).toBe('user-2');
      expect(unchangedExpense.splitBetween).toEqual(['user-2', 'user-3']);
    });
  });
});
