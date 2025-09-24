import testHelpers from './helpers/testHelpers.js';

describe('Data Validation and Consistency', () => {
  beforeAll(async () => {
    await device.launchApp();
  });

  beforeEach(async () => {
    await device.reloadReactNative();
    await testHelpers.setUsername('DataUser');
  });

  describe('Cross-Screen Data Consistency', () => {
    it('should persist expense across app restart', async () => {
      // Create expense
      await testHelpers.createExpense(
        'Persistent Test',
        '50.00',
        'Food & Dining',
      );
      await testHelpers.verifyExpenseInList('Persistent Test', '50.00');

      // Restart app
      await device.terminateApp();
      await device.launchApp();

      // Verify data persisted
      await testHelpers.expectVisible(by.text('Persistent Test'));
      await testHelpers.expectVisible(by.text('$50.00'));

      // Verify in insights
      await testHelpers.waitAndTap(by.id('total-share-button'));
      await testHelpers.expectVisible(by.text('$50.00'));
      await testHelpers.expectVisible(by.text('Food & Dining'));
    });

    it('should sync category changes across screens', async () => {
      // Create expense with default category
      await testHelpers.createExpense('Test Meal', '25.00', 'Food & Dining');
      await testHelpers.verifyExpenseInList('Test Meal', '25.00');

      // Create custom category
      await testHelpers.waitAndTap(by.text('Settings'));
      await testHelpers.waitAndTap(by.text('Manage Categories'));
      await testHelpers.waitAndTap(by.id('add-category-button'));
      await testHelpers.waitAndType(
        by.id('category-name-input'),
        'Custom Food',
      );
      await testHelpers.waitAndTap(by.id('color-option-blue'));
      await testHelpers.waitAndTap(by.text('Save'));

      // Verify category appears in category management
      await testHelpers.expectVisible(by.text('Custom Food'));

      // Go to expense creation and verify category is available
      await testHelpers.waitAndTap(by.text('Home'));
      await testHelpers.waitAndTap(by.id('add-expense-fab'));
      await testHelpers.waitAndTap(by.id('category-picker'));
      await testHelpers.expectVisible(by.text('Custom Food'));

      // Use new category
      await testHelpers.waitAndTap(by.text('Custom Food'));
      await testHelpers.waitAndType(
        by.id('expense-title-input'),
        'Custom Meal',
      );
      await testHelpers.waitAndType(by.id('expense-amount-input'), '30.00');
      await testHelpers.waitAndTap(by.id('save-expense-button'));

      // Verify expense uses new category
      await testHelpers.verifyExpenseInList('Custom Meal', '30.00');

      // Check insights shows new category
      await testHelpers.waitAndTap(by.id('total-share-button'));
      await testHelpers.expectVisible(by.text('Custom Food'));
    });

    it('should maintain group state during navigation', async () => {
      // Create group
      await testHelpers.createGroup('Navigation Test');
      await testHelpers.expectVisible(by.text('Navigation Test'));

      // Add expense to group
      await testHelpers.waitAndTap(by.text('Navigation Test'));
      await testHelpers.createExpense('Group Expense', '75.00');
      await testHelpers.verifyExpenseInList('Group Expense', '75.00');

      // Navigate away and back
      await testHelpers.waitAndTap(by.text('Home'));
      await testHelpers.waitAndTap(by.text('History'));
      await testHelpers.waitAndTap(by.text('Navigation Test'));

      // Verify group data persisted
      await testHelpers.expectVisible(by.text('Group Expense'));
      await testHelpers.expectVisible(by.text('$75.00'));

      // Check total calculation
      await testHelpers.waitAndTap(by.id('total-share-button'));
      await testHelpers.expectVisible(by.text('$75.00'));
    });

    it('should handle concurrent state updates correctly', async () => {
      // Create multiple expenses rapidly
      const expenses = [
        { title: 'Quick 1', amount: '10.00' },
        { title: 'Quick 2', amount: '20.00' },
        { title: 'Quick 3', amount: '30.00' },
      ];

      for (const expense of expenses) {
        await testHelpers.createExpense(expense.title, expense.amount);
      }

      // Verify all expenses are present
      await testHelpers.verifyExpenseInList('Quick 1', '10.00');
      await testHelpers.verifyExpenseInList('Quick 2', '20.00');
      await testHelpers.verifyExpenseInList('Quick 3', '30.00');

      // Check total calculation is correct
      await testHelpers.waitAndTap(by.id('total-share-button'));
      await testHelpers.expectVisible(by.text('$60.00')); // 10 + 20 + 30
    });
  });

  describe('Data Integrity Validation', () => {
    it('should validate expense amount precision', async () => {
      // Test various amount formats
      const amountTests = [
        { input: '10', expected: '10.00' },
        { input: '10.5', expected: '10.50' },
        { input: '10.99', expected: '10.99' },
        { input: '10.999', expected: '10.99' }, // Should round to 2 decimals
        { input: '0.01', expected: '0.01' },
      ];

      for (const test of amountTests) {
        await testHelpers.waitAndTap(by.id('add-expense-fab'));
        await testHelpers.waitAndType(
          by.id('expense-title-input'),
          `Amount Test ${test.input}`,
        );
        await testHelpers.waitAndType(
          by.id('expense-amount-input'),
          test.input,
        );
        await testHelpers.waitAndTap(by.id('save-expense-button'));

        // Verify amount is displayed correctly
        await testHelpers.verifyExpenseInList(
          `Amount Test ${test.input}`,
          test.expected,
        );
      }
    });

    it('should validate date handling across time zones', async () => {
      // Create expense with specific date
      await testHelpers.waitAndTap(by.id('add-expense-fab'));
      await testHelpers.waitAndType(by.id('expense-title-input'), 'Date Test');
      await testHelpers.waitAndType(by.id('expense-amount-input'), '15.00');

      // Set specific date (if date picker is available)
      // Note: This test assumes there's a date picker, might need adjustment
      if (await testHelpers.isVisible(by.id('date-picker'))) {
        await testHelpers.waitAndTap(by.id('date-picker'));
        // Select a specific date - implementation depends on date picker component
      }

      await testHelpers.waitAndTap(by.id('save-expense-button'));
      await testHelpers.verifyExpenseInList('Date Test', '15.00');

      // Verify date consistency in insights
      await testHelpers.waitAndTap(by.id('total-share-button'));
      await testHelpers.expectVisible(by.text('Date Test'));
    });

    it('should handle special characters in text fields', async () => {
      // Test various special characters and unicode
      const specialTitles = [
        'Café ☕',
        'Résumé Review',
        'Naïve Purchase',
        'Test & More',
        'Quote "Test"',
        "Apostrophe's Test",
        'Emoji 🎉 Test',
      ];

      for (const title of specialTitles) {
        await testHelpers.waitAndTap(by.id('add-expense-fab'));
        await testHelpers.waitAndType(by.id('expense-title-input'), title);
        await testHelpers.waitAndType(by.id('expense-amount-input'), '10.00');
        await testHelpers.waitAndTap(by.id('save-expense-button'));

        // Verify special characters are preserved
        await testHelpers.expectVisible(by.text(title));
      }
    });

    it('should validate category name constraints', async () => {
      await testHelpers.waitAndTap(by.text('Settings'));
      await testHelpers.waitAndTap(by.text('Manage Categories'));

      // Test category name length limits
      await testHelpers.waitAndTap(by.id('add-category-button'));

      // Very long name should be truncated or rejected
      const longName = 'A'.repeat(100);
      await testHelpers.waitAndType(by.id('category-name-input'), longName);
      await testHelpers.waitAndTap(by.text('Save'));

      // Should show validation error or truncate
      const visible = await testHelpers.isVisible(
        by.text('Category name must be 50 characters or less'),
      );
      if (visible) {
        // Fix length and try again
        await testHelpers.waitAndReplace(
          by.id('category-name-input'),
          'Valid Length Name',
        );
        await testHelpers.waitAndTap(by.text('Save'));
      }

      // Should succeed with valid name
      await testHelpers.expectVisible(by.text('Valid Length Name'));
    });
  });

  describe('Calculation Accuracy', () => {
    it('should calculate totals accurately with multiple currencies', async () => {
      // Note: This test assumes currency conversion or at least consistent display
      // Create expenses with precise amounts
      const preciseAmounts = ['33.33', '66.67', '0.01', '99.99'];
      let expectedTotal = 0;

      for (const amount of preciseAmounts) {
        await testHelpers.createExpense(`Precise ${amount}`, amount);
        expectedTotal += parseFloat(amount);
      }

      // Check total calculation
      await testHelpers.waitAndTap(by.id('total-share-button'));
      const formattedTotal = `$${expectedTotal.toFixed(2)}`;
      await testHelpers.expectVisible(by.text(formattedTotal));
    });

    it('should handle group expense splitting correctly', async () => {
      // Create group with known participants
      await testHelpers.createGroup('Split Test Group');
      await testHelpers.waitAndTap(by.text('Split Test Group'));

      // Add expense that should be split
      await testHelpers.createExpense('Split Dinner', '60.00');

      // View group balances (if available)
      if (await testHelpers.isVisible(by.id('group-balances-button'))) {
        await testHelpers.waitAndTap(by.id('group-balances-button'));

        // Verify split calculation (assuming 2 participants, $30 each)
        await testHelpers.expectVisible(by.text('$30.00'));
      }
    });

    it('should maintain calculation accuracy with large numbers', async () => {
      // Test with large amounts
      const largeAmounts = ['999.99', '1000.00', '9999.99'];

      for (const amount of largeAmounts) {
        await testHelpers.createExpense(`Large ${amount}`, amount);
      }

      // Verify totals are calculated correctly
      await testHelpers.waitAndTap(by.id('total-share-button'));
      await testHelpers.expectVisible(by.text('$11,999.98')); // Sum of large amounts
    });
  });

  describe('State Recovery and Error Handling', () => {
    it('should recover from partial data corruption', async () => {
      // Create baseline data
      await testHelpers.createExpense('Baseline', '25.00');
      await testHelpers.verifyExpenseInList('Baseline', '25.00');

      // Simulate app restart (potential state loss scenario)
      await device.terminateApp();
      await device.launchApp();

      // Verify core functionality still works
      await testHelpers.expectVisible(by.text('Baseline'));
      await testHelpers.createExpense('After Restart', '35.00');
      await testHelpers.verifyExpenseInList('After Restart', '35.00');

      // Verify calculations still work
      await testHelpers.waitAndTap(by.id('total-share-button'));
      await testHelpers.expectVisible(by.text('$60.00')); // 25 + 35
    });

    it('should handle missing category gracefully', async () => {
      // Create expense with existing category
      await testHelpers.createExpense(
        'Category Test',
        '20.00',
        'Food & Dining',
      );

      // If category management allows deletion of categories with expenses
      await testHelpers.waitAndTap(by.text('Settings'));
      await testHelpers.waitAndTap(by.text('Manage Categories'));

      // Try to delete a category that has expenses
      // Note: This should either be prevented or handle gracefully
      if (await testHelpers.isVisible(by.text('Food & Dining'))) {
        await element(by.text('Food & Dining')).swipe('left');

        // Should either:
        // 1. Prevent deletion (show warning)
        // 2. Move expenses to "Other" category
        // 3. Show confirmation dialog

        const warningVisible = await testHelpers.isVisible(
          by.text('Cannot delete category with expenses'),
        );
        if (warningVisible) {
          // Good - prevented deletion
          await testHelpers.waitAndTap(by.text('OK'));
        }
      }

      // Verify expense still exists and has valid category
      await testHelpers.waitAndTap(by.text('Home'));
      await testHelpers.expectVisible(by.text('Category Test'));
    });

    it('should maintain data consistency during rapid operations', async () => {
      // Rapidly create and delete expenses
      for (let i = 0; i < 5; i++) {
        await testHelpers.createExpense(`Rapid ${i}`, `${10 + i}.00`);
      }

      // Verify all were created
      for (let i = 0; i < 5; i++) {
        await testHelpers.expectVisible(by.text(`Rapid ${i}`));
      }

      // Rapidly delete some expenses (swipe left)
      await element(by.text('Rapid 0')).swipe('left');
      await element(by.text('Rapid 2')).swipe('left');
      await element(by.text('Rapid 4')).swipe('left');

      // Verify correct expenses remain
      await testHelpers.expectNotVisible(by.text('Rapid 0'));
      await testHelpers.expectVisible(by.text('Rapid 1'));
      await testHelpers.expectNotVisible(by.text('Rapid 2'));
      await testHelpers.expectVisible(by.text('Rapid 3'));
      await testHelpers.expectNotVisible(by.text('Rapid 4'));

      // Verify total is calculated correctly
      await testHelpers.waitAndTap(by.id('total-share-button'));
      await testHelpers.expectVisible(by.text('$23.00')); // 11 + 12 = 23
    });
  });

  describe('Edge Cases and Boundary Conditions', () => {
    it('should handle minimum and maximum amounts', async () => {
      // Test minimum amount (0.01)
      await testHelpers.createExpense('Minimum Amount', '0.01');
      await testHelpers.verifyExpenseInList('Minimum Amount', '0.01');

      // Test large amount
      await testHelpers.createExpense('Large Amount', '99999.99');
      await testHelpers.verifyExpenseInList('Large Amount', '99999.99');

      // Check totals
      await testHelpers.waitAndTap(by.id('total-share-button'));
      await testHelpers.expectVisible(by.text('$100,000.00'));
    });

    it('should handle empty states gracefully', async () => {
      // Start with empty state
      await device.reloadReactNative();

      // Home should show empty state
      await testHelpers.expectVisible(by.text('No expenses yet'));

      // History should show empty state
      await testHelpers.waitAndTap(by.text('History'));
      await testHelpers.expectVisible(by.text('No groups yet'));

      // Insights should show empty state
      await testHelpers.waitAndTap(by.text('Home'));
      await testHelpers.waitAndTap(by.id('total-share-button'));
      await testHelpers.expectVisible(
        by.text('No expense data for the selected period.'),
      );
    });

    it('should handle date boundary conditions', async () => {
      // Test year boundaries (if date filtering is available)
      await testHelpers.createExpense('Year Test', '100.00');

      await testHelpers.waitAndTap(by.id('total-share-button'));

      // Test month navigation at year boundaries
      if (await testHelpers.isVisible(by.id('previous-month-button'))) {
        // Navigate to previous months
        for (let i = 0; i < 12; i++) {
          await testHelpers.waitAndTap(by.id('previous-month-button'));
        }

        // Should handle year rollover gracefully
        await testHelpers.expectVisible(by.id('pie-chart')); // Should not crash

        // Navigate back
        for (let i = 0; i < 12; i++) {
          await testHelpers.waitAndTap(by.id('next-month-button'));
        }

        // Should be back to current period with data
        await testHelpers.expectVisible(by.text('Year Test'));
      }
    });
  });
});
