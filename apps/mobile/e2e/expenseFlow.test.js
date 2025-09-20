describe('Expense Management Flow', () => {
  beforeAll(async () => {
    await device.launchApp();
  });

  beforeEach(async () => {
    await device.reloadReactNative();
  });

  describe('New User Onboarding', () => {
    it('should complete new user expense journey', async () => {
      // Step 1: Set up username (required for groups)
      await testHelpers.setUsername('TestUser');

      // Step 2: Navigate to Home
      await testHelpers.waitAndTap(by.text('Home'));

      // Step 3: Add first expense
      await testHelpers.waitAndTap(by.id('add-expense-fab'));
      await testHelpers.waitAndType(by.id('expense-title-input'), 'Coffee');
      await testHelpers.waitAndType(by.id('expense-amount-input'), '4.50');

      // Step 4: Select category
      await testHelpers.waitAndTap(by.id('category-picker'));
      await testHelpers.waitAndTap(by.text('Food & Dining'));

      // Step 5: Save expense
      await testHelpers.waitAndTap(by.id('save-expense-button'));

      // Step 6: Verify expense appears in list
      await testHelpers.verifyExpenseInList('Coffee', '4.50');
    });

    it('should handle username requirement for group creation', async () => {
      // Try to create group without username
      await testHelpers.waitAndTap(by.text('History'));
      await testHelpers.waitAndTap(by.id('add-group-button'));

      // Should show username required popup
      await testHelpers.expectVisible(by.text('username required'));

      // Tap "Go to Settings"
      await testHelpers.waitAndTap(by.text('Go to Settings'));

      // Should navigate to settings
      await testHelpers.expectVisible(by.text('Your Name:'));

      // Set username
      await testHelpers.waitAndReplace(by.id('username-input'), 'GroupUser');
      await testHelpers.waitAndTap(by.text('Save Settings'));

      // Verify success
      await testHelpers.expectVisible(by.text('Settings saved successfully'));

      // Now try creating group again
      await testHelpers.waitAndTap(by.text('History'));
      await testHelpers.waitAndTap(by.id('add-group-button'));

      // Should now be able to create group
      await testHelpers.waitAndType(by.id('group-name-input'), 'Test Group');
      await testHelpers.waitAndTap(by.text('Create'));

      // Verify group was created
      await testHelpers.expectVisible(by.text('Test Group'));
    });
  });

  describe('Expense Management', () => {
    beforeEach(async () => {
      // Set up username for each test
      await testHelpers.setUsername('ExpenseUser');
    });

    it('should create, edit, and delete expense', async () => {
      // Create expense
      await testHelpers.createExpense('Lunch', '12.75', 'Food & Dining');

      // Verify expense is created
      await testHelpers.verifyExpenseInList('Lunch', '12.75');

      // Edit expense (tap on expense)
      await testHelpers.waitAndTap(by.text('Lunch'));

      // Modify title and amount
      await testHelpers.waitAndReplace(by.id('expense-title-input'), 'Dinner');
      await testHelpers.waitAndReplace(by.id('expense-amount-input'), '25.00');

      // Save changes
      await testHelpers.waitAndTap(by.id('save-expense-button'));

      // Verify changes
      await testHelpers.verifyExpenseInList('Dinner', '25.00');
      await testHelpers.expectNotVisible(by.text('Lunch'));

      // Delete expense (swipe left)
      await element(by.text('Dinner')).swipe('left');

      // Verify expense is deleted
      await testHelpers.expectNotVisible(by.text('Dinner'));
    });

    it('should validate expense form inputs', async () => {
      // Try to create expense without required fields
      await testHelpers.waitAndTap(by.id('add-expense-fab'));

      // Try to save without title and amount
      await testHelpers.waitAndTap(by.id('save-expense-button'));

      // Should show validation errors
      await testHelpers.expectVisible(by.text('Title is required'));
      await testHelpers.expectVisible(by.text('Amount must be greater than 0'));

      // Add title but invalid amount
      await testHelpers.waitAndType(by.id('expense-title-input'), 'Test');
      await testHelpers.waitAndType(by.id('expense-amount-input'), '-10');

      await testHelpers.waitAndTap(by.id('save-expense-button'));

      // Should still show amount error
      await testHelpers.expectVisible(by.text('Amount must be greater than 0'));

      // Fix amount
      await testHelpers.waitAndReplace(by.id('expense-amount-input'), '10.00');

      // Should now be able to save
      await testHelpers.waitAndTap(by.id('save-expense-button'));

      // Should navigate back and show expense
      await testHelpers.verifyExpenseInList('Test', '10.00');
    });

    it('should create expense with optional caption', async () => {
      await testHelpers.waitAndTap(by.id('add-expense-fab'));
      await testHelpers.waitAndType(by.id('expense-title-input'), 'Business Lunch');
      await testHelpers.waitAndType(by.id('expense-amount-input'), '45.00');
      await testHelpers.waitAndType(by.id('expense-caption-input'), 'Client meeting');

      await testHelpers.waitAndTap(by.id('save-expense-button'));

      // Verify expense with caption
      await testHelpers.verifyExpenseInList('Business Lunch', '45.00');
      await testHelpers.expectVisible(by.text('Client meeting'));
    });
  });

  describe('Group Management', () => {
    beforeEach(async () => {
      // Set up username for each test
      await testHelpers.setUsername('GroupManager');
    });

    it('should create and manage group expense', async () => {
      // Create new group
      await testHelpers.createGroup('Dinner Group');

      // Verify group exists
      await testHelpers.expectVisible(by.text('Dinner Group'));

      // Add expense to group
      await testHelpers.waitAndTap(by.text('Dinner Group'));
      await testHelpers.waitAndTap(by.id('add-expense-fab'));

      // Fill group expense form
      await testHelpers.waitAndType(by.id('expense-title-input'), 'Restaurant Bill');
      await testHelpers.waitAndType(by.id('expense-amount-input'), '80.00');

      // Save group expense
      await testHelpers.waitAndTap(by.id('save-expense-button'));

      // Verify group expense
      await testHelpers.verifyExpenseInList('Restaurant Bill', '80.00');

      // Check that expense has group tag
      await testHelpers.expectVisible(by.id('group-tag'));
    });

    it('should show group insights and totals', async () => {
      // Create group with expenses
      await testHelpers.createGroup('Trip Group');
      await testHelpers.waitAndTap(by.text('Trip Group'));

      // Add multiple expenses
      await testHelpers.createExpense('Hotel', '150.00');
      await testHelpers.createExpense('Food', '75.00');
      await testHelpers.createExpense('Transport', '25.00');

      // View group insights
      await testHelpers.waitAndTap(by.id('total-share-button'));

      // Should show pie chart and breakdown
      await testHelpers.expectVisible(by.id('pie-chart'));
      await testHelpers.expectVisible(by.text('Hotel'));
      await testHelpers.expectVisible(by.text('$150.00'));

      // Verify total calculation
      await testHelpers.expectVisible(by.text('$250.00')); // Total of all expenses
    });

    it('should calculate participant balances', async () => {
      // Create group
      await testHelpers.createGroup('Split Test');
      await testHelpers.waitAndTap(by.text('Split Test'));

      // Add group expense
      await testHelpers.createExpense('Shared Meal', '60.00');

      // View group details/balances
      await testHelpers.waitAndTap(by.id('group-balances-button'));

      // Should show balance calculations
      await testHelpers.expectVisible(by.text('Balance Summary'));
      await testHelpers.expectVisible(by.text('GroupManager')); // Current user

      // Verify balance display (assuming equal split)
      await testHelpers.expectVisible(by.text('$30.00')); // Half of 60
    });
  });

  describe('Category Management', () => {
    beforeEach(async () => {
      await testHelpers.setUsername('CategoryUser');
    });

    it('should create, edit, and delete categories', async () => {
      // Navigate to category management
      await testHelpers.waitAndTap(by.text('Settings'));
      await testHelpers.waitAndTap(by.text('Manage Categories'));

      // Add new category
      await testHelpers.waitAndTap(by.id('add-category-button'));
      await testHelpers.waitAndType(by.id('category-name-input'), 'Healthcare');

      // Select color
      await testHelpers.waitAndTap(by.id('color-option-green'));

      // Save category
      await testHelpers.waitAndTap(by.text('Save'));

      // Verify category was created
      await testHelpers.expectVisible(by.text('Healthcare'));

      // Edit category
      await testHelpers.waitAndTap(by.text('Healthcare'));
      await testHelpers.waitAndReplace(by.id('category-name-input'), 'Medical');
      await testHelpers.waitAndTap(by.text('Save'));

      // Verify category was updated
      await testHelpers.expectVisible(by.text('Medical'));
      await testHelpers.expectNotVisible(by.text('Healthcare'));

      // Delete category (swipe left)
      await element(by.text('Medical')).swipe('left');

      // Verify category was deleted
      await testHelpers.expectNotVisible(by.text('Medical'));
    });

    it('should not allow deleting default "Other" category', async () => {
      // Navigate to category management
      await testHelpers.waitAndTap(by.text('Settings'));
      await testHelpers.waitAndTap(by.text('Manage Categories'));

      // Try to delete "Other" category
      await element(by.text('Other')).swipe('left');

      // Should not be deleted (no delete action or warning message)
      await testHelpers.expectVisible(by.text('Other'));
    });

    it('should use new category in expense creation', async () => {
      // Create new category first
      await testHelpers.waitAndTap(by.text('Settings'));
      await testHelpers.waitAndTap(by.text('Manage Categories'));
      await testHelpers.waitAndTap(by.id('add-category-button'));
      await testHelpers.waitAndType(by.id('category-name-input'), 'Gym');
      await testHelpers.waitAndTap(by.text('Save'));

      // Go to home and create expense
      await testHelpers.waitAndTap(by.text('Home'));
      await testHelpers.waitAndTap(by.id('add-expense-fab'));
      await testHelpers.waitAndType(by.id('expense-title-input'), 'Membership');
      await testHelpers.waitAndType(by.id('expense-amount-input'), '50.00');

      // Select new category
      await testHelpers.waitAndTap(by.id('category-picker'));
      await testHelpers.waitAndTap(by.text('Gym'));

      // Save expense
      await testHelpers.waitAndTap(by.id('save-expense-button'));

      // Verify expense uses new category
      await testHelpers.verifyExpenseInList('Membership', '50.00');
    });
  });

  describe('Insights and Analytics', () => {
    beforeEach(async () => {
      await testHelpers.setUsername('AnalyticsUser');
    });

    it('should navigate insights and view analytics', async () => {
      // Create test data (multiple expenses)
      const expenses = [
        { title: 'Groceries', amount: '150.00', category: 'Food & Dining' },
        { title: 'Gas', amount: '45.00', category: 'Transportation' },
        { title: 'Movie', amount: '25.00', category: 'Entertainment' }
      ];

      for (const expense of expenses) {
        await testHelpers.createExpense(expense.title, expense.amount, expense.category);
      }

      // Navigate to insights
      await testHelpers.waitAndTap(by.id('total-share-button'));

      // Verify insights screen elements
      await testHelpers.expectVisible(by.id('pie-chart'));
      await testHelpers.expectVisible(by.text('Food & Dining'));
      await testHelpers.expectVisible(by.text('$150.00'));
      await testHelpers.expectVisible(by.text('Transportation'));
      await testHelpers.expectVisible(by.text('$45.00'));

      // Test time period navigation
      await testHelpers.waitAndTap(by.id('previous-month-button'));
      await testHelpers.waitAndTap(by.id('next-month-button'));

      // Test date picker
      await testHelpers.waitAndTap(by.id('date-period-selector'));
      await testHelpers.waitAndTap(by.text('This Year'));

      // Should update to yearly view
      await testHelpers.expectVisible(by.text('2025')); // Current year
    });

    it('should handle empty insights gracefully', async () => {
      // Navigate to insights without any expenses
      await testHelpers.waitAndTap(by.id('total-share-button'));

      // Should show no data message
      await testHelpers.expectVisible(by.text('No expense data for the selected period.'));
    });

    it('should filter insights by time period', async () => {
      // Create expense for current month
      await testHelpers.createExpense('Current Month', '100.00');

      // Navigate to insights
      await testHelpers.waitAndTap(by.id('total-share-button'));

      // Should show current expense
      await testHelpers.expectVisible(by.text('Current Month'));

      // Navigate to previous month (should be empty)
      await testHelpers.waitAndTap(by.id('previous-month-button'));

      // Should show no data for previous month
      await testHelpers.expectVisible(by.text('No expense data for the selected period.'));

      // Navigate back to current month
      await testHelpers.waitAndTap(by.id('next-month-button'));

      // Should show expense again
      await testHelpers.expectVisible(by.text('Current Month'));
    });
  });

  describe('Data Persistence', () => {
    it('should persist data across app restarts', async () => {
      // Set username and create expense
      await testHelpers.setUsername('PersistenceUser');
      await testHelpers.createExpense('Persistent Expense', '25.00');

      // Verify expense exists
      await testHelpers.verifyExpenseInList('Persistent Expense', '25.00');

      // Restart app
      await device.terminateApp();
      await device.launchApp();

      // Check if data persisted
      await testHelpers.expectVisible(by.text('Persistent Expense'));
      await testHelpers.expectVisible(by.text('$25.00'));

      // Check if username persisted
      await testHelpers.waitAndTap(by.text('Settings'));
      await testHelpers.expectVisible(by.displayValue('PersistenceUser'));
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid expense amounts gracefully', async () => {
      await testHelpers.waitAndTap(by.id('add-expense-fab'));
      await testHelpers.waitAndType(by.id('expense-title-input'), 'Invalid Amount Test');

      // Try various invalid amounts
      const invalidAmounts = ['abc', '0', '-10', '', '   '];

      for (const amount of invalidAmounts) {
        await testHelpers.waitAndReplace(by.id('expense-amount-input'), amount);
        await testHelpers.waitAndTap(by.id('save-expense-button'));

        // Should show error and not save
        await testHelpers.expectVisible(by.id('expense-amount-input'));
        // Should still be on the form screen
      }

      // Valid amount should work
      await testHelpers.waitAndReplace(by.id('expense-amount-input'), '10.00');
      await testHelpers.waitAndTap(by.id('save-expense-button'));

      // Should navigate back and show expense
      await testHelpers.verifyExpenseInList('Invalid Amount Test', '10.00');
    });

    it('should handle empty group name validation', async () => {
      await testHelpers.setUsername('ValidationUser');
      await testHelpers.waitAndTap(by.text('History'));
      await testHelpers.waitAndTap(by.id('add-group-button'));

      // Try to create group with empty name
      await testHelpers.waitAndTap(by.text('Create'));

      // Should show validation error
      await testHelpers.expectVisible(by.text('Group name is required'));

      // Add valid name
      await testHelpers.waitAndType(by.id('group-name-input'), 'Valid Group');
      await testHelpers.waitAndTap(by.text('Create'));

      // Should create group successfully
      await testHelpers.expectVisible(by.text('Valid Group'));
    });
  });
});