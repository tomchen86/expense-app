import testHelpers from './helpers/testHelpers.js';

describe('User Onboarding Journey', () => {
  beforeAll(async () => {
    await device.launchApp();
  });

  beforeEach(async () => {
    await device.reloadReactNative();
  });

  describe('First Time User Experience', () => {
    it('should complete first-time user setup', async () => {
      // Step 1: App should start on Home screen for new users
      await testHelpers.expectVisible(by.text('Home'));
      await testHelpers.expectVisible(by.text('No expenses yet'));

      // Step 2: User tries to create first expense
      await testHelpers.waitAndTap(by.id('add-expense-fab'));

      // Step 3: Fill out expense form
      await testHelpers.waitAndType(
        by.id('expense-title-input'),
        'First Coffee',
      );
      await testHelpers.waitAndType(by.id('expense-amount-input'), '4.50');

      // Step 4: Select category from defaults
      await testHelpers.waitAndTap(by.id('category-picker'));
      await testHelpers.waitAndTap(by.text('Food & Dining'));

      // Step 5: Save first expense
      await testHelpers.waitAndTap(by.id('save-expense-button'));

      // Step 6: Should return to Home with expense visible
      await testHelpers.expectVisible(by.text('Home'));
      await testHelpers.verifyExpenseInList('First Coffee', '4.50');

      // Step 7: Verify total is displayed
      await testHelpers.expectVisible(by.text('$4.50'));
    });

    it('should guide user through username setup for groups', async () => {
      // Step 1: User tries to create a group without username
      await testHelpers.waitAndTap(by.text('History'));
      await testHelpers.expectVisible(by.text('Groups'));

      // Step 2: Try to add group
      await testHelpers.waitAndTap(by.id('add-group-button'));

      // Step 3: Should show username requirement dialog
      await testHelpers.expectVisible(by.text('Username Required'));
      await testHelpers.expectVisible(
        by.text('You need to set a username before creating groups'),
      );

      // Step 4: User chooses to set username
      await testHelpers.waitAndTap(by.text('Go to Settings'));

      // Step 5: Should navigate to Settings screen
      await testHelpers.expectVisible(by.text('Settings'));
      await testHelpers.expectVisible(by.text('Your Name:'));

      // Step 6: User enters username
      await testHelpers.waitAndType(by.id('username-input'), 'FirstTimeUser');
      await testHelpers.waitAndTap(by.text('Save Settings'));

      // Step 7: Should show success message
      await testHelpers.expectVisible(by.text('Settings saved successfully'));

      // Step 8: Navigate back to History
      await testHelpers.waitAndTap(by.text('History'));

      // Step 9: Should now be able to create group
      await testHelpers.waitAndTap(by.id('add-group-button'));
      await testHelpers.waitAndType(
        by.id('group-name-input'),
        'My First Group',
      );
      await testHelpers.waitAndTap(by.text('Create'));

      // Step 10: Verify group was created
      await testHelpers.expectVisible(by.text('My First Group'));
    });

    it('should require username for group features only', async () => {
      // User should be able to create individual expenses without username
      await testHelpers.createExpense('Solo Lunch', '15.00', 'Food & Dining');
      await testHelpers.verifyExpenseInList('Solo Lunch', '15.00');

      // User should be able to view insights without username
      await testHelpers.waitAndTap(by.id('total-share-button'));
      await testHelpers.expectVisible(by.id('pie-chart'));
      await testHelpers.expectVisible(by.text('Food & Dining'));

      // User should be able to manage categories without username
      await testHelpers.waitAndTap(by.text('Settings'));
      await testHelpers.waitAndTap(by.text('Manage Categories'));
      await testHelpers.expectVisible(by.text('Food & Dining'));
      await testHelpers.expectVisible(by.text('Transportation'));

      // But group features should require username
      await testHelpers.waitAndTap(by.text('History'));
      await testHelpers.waitAndTap(by.id('add-group-button'));
      await testHelpers.expectVisible(by.text('Username Required'));
    });
  });

  describe('Progressive Feature Discovery', () => {
    beforeEach(async () => {
      await testHelpers.setUsername('DiscoveryUser');
    });

    it('should guide through first group creation', async () => {
      // Step 1: User navigates to History (Groups)
      await testHelpers.waitAndTap(by.text('History'));
      await testHelpers.expectVisible(by.text('No groups yet'));

      // Step 2: Create first group
      await testHelpers.waitAndTap(by.id('add-group-button'));
      await testHelpers.waitAndType(by.id('group-name-input'), 'Family');
      await testHelpers.waitAndTap(by.text('Create'));

      // Step 3: Should see group with helpful message
      await testHelpers.expectVisible(by.text('Family'));
      await testHelpers.expectVisible(
        by.text('Add expenses to start tracking'),
      );

      // Step 4: User taps on group
      await testHelpers.waitAndTap(by.text('Family'));

      // Step 5: Should see group detail with add expense prompt
      await testHelpers.expectVisible(by.text('Family'));
      await testHelpers.expectVisible(by.text('No expenses in this group yet'));
    });

    it('should introduce insights after sufficient data', async () => {
      // Create some expense data
      const expenses = [
        { title: 'Groceries', amount: '75.00', category: 'Food & Dining' },
        { title: 'Gas', amount: '45.00', category: 'Transportation' },
        { title: 'Coffee', amount: '5.00', category: 'Food & Dining' },
        { title: 'Movie', amount: '20.00', category: 'Entertainment' },
      ];

      for (const expense of expenses) {
        await testHelpers.createExpense(
          expense.title,
          expense.amount,
          expense.category,
        );
      }

      // User should now see meaningful insights
      await testHelpers.waitAndTap(by.id('total-share-button'));

      // Should show rich analytics
      await testHelpers.expectVisible(by.id('pie-chart'));
      await testHelpers.expectVisible(by.text('Food & Dining')); // Largest category
      await testHelpers.expectVisible(by.text('$80.00')); // 75 + 5
      await testHelpers.expectVisible(by.text('Transportation'));
      await testHelpers.expectVisible(by.text('$45.00'));

      // Should show period navigation
      await testHelpers.expectVisible(by.id('previous-month-button'));
      await testHelpers.expectVisible(by.id('next-month-button'));
    });

    it('should handle category customization workflow', async () => {
      // Step 1: User realizes they need a custom category
      await testHelpers.waitAndTap(by.id('add-expense-fab'));
      await testHelpers.waitAndTap(by.id('category-picker'));

      // Step 2: Default categories shown
      await testHelpers.expectVisible(by.text('Food & Dining'));
      await testHelpers.expectVisible(by.text('Transportation'));
      await testHelpers.expectVisible(by.text('Other'));

      // Step 3: User wants to add custom category
      await testHelpers.waitAndTap(by.text('Cancel')); // Close picker
      await testHelpers.waitAndTap(by.text('Cancel')); // Close expense form

      // Step 4: Navigate to category management
      await testHelpers.waitAndTap(by.text('Settings'));
      await testHelpers.waitAndTap(by.text('Manage Categories'));

      // Step 5: Add new category
      await testHelpers.waitAndTap(by.id('add-category-button'));
      await testHelpers.waitAndType(
        by.id('category-name-input'),
        'Gym & Fitness',
      );
      await testHelpers.waitAndTap(by.id('color-option-green'));
      await testHelpers.waitAndTap(by.text('Save'));

      // Step 6: Verify category was added
      await testHelpers.expectVisible(by.text('Gym & Fitness'));

      // Step 7: Use new category in expense
      await testHelpers.waitAndTap(by.text('Home'));
      await testHelpers.waitAndTap(by.id('add-expense-fab'));
      await testHelpers.waitAndType(
        by.id('expense-title-input'),
        'Monthly Membership',
      );
      await testHelpers.waitAndType(by.id('expense-amount-input'), '50.00');
      await testHelpers.waitAndTap(by.id('category-picker'));
      await testHelpers.waitAndTap(by.text('Gym & Fitness'));
      await testHelpers.waitAndTap(by.id('save-expense-button'));

      // Step 8: Verify expense uses new category
      await testHelpers.verifyExpenseInList('Monthly Membership', '50.00');
    });
  });

  describe('Data Migration and Settings', () => {
    it('should handle settings preferences setup', async () => {
      // Navigate to settings
      await testHelpers.waitAndTap(by.text('Settings'));

      // Check default settings
      await testHelpers.expectVisible(by.text('Currency: USD'));
      await testHelpers.expectVisible(by.text('Theme: Light'));

      // Change currency
      await testHelpers.waitAndTap(by.text('Currency: USD'));
      await testHelpers.waitAndTap(by.text('EUR'));
      await testHelpers.expectVisible(by.text('Currency: EUR'));

      // Change theme
      await testHelpers.waitAndTap(by.text('Theme: Light'));
      await testHelpers.waitAndTap(by.text('Dark'));
      await testHelpers.expectVisible(by.text('Theme: Dark'));

      // Save settings
      await testHelpers.waitAndTap(by.text('Save Settings'));
      await testHelpers.expectVisible(by.text('Settings saved successfully'));

      // Verify settings persist across navigation
      await testHelpers.waitAndTap(by.text('Home'));
      await testHelpers.waitAndTap(by.text('Settings'));
      await testHelpers.expectVisible(by.text('Currency: EUR'));
      await testHelpers.expectVisible(by.text('Theme: Dark'));
    });

    it('should handle display name setup', async () => {
      await testHelpers.waitAndTap(by.text('Settings'));

      // Set display name (different from username)
      await testHelpers.waitAndType(by.id('display-name-input'), 'John Doe');
      await testHelpers.waitAndTap(by.text('Save Settings'));

      // Verify display name is used in UI
      await testHelpers.expectVisible(by.text('Settings saved successfully'));

      // Create a group to see if display name is used
      await testHelpers.waitAndTap(by.text('History'));
      await testHelpers.waitAndTap(by.id('add-group-button'));
      await testHelpers.waitAndType(by.id('group-name-input'), 'Test Display');
      await testHelpers.waitAndTap(by.text('Create'));

      // In group context, should show display name or username
      await testHelpers.waitAndTap(by.text('Test Display'));
      await testHelpers.expectVisible(by.text('Test Display'));
    });
  });

  describe('Error Recovery and Help', () => {
    it('should handle network-like errors gracefully', async () => {
      // Simulate user entering data that might fail to save
      await testHelpers.waitAndTap(by.id('add-expense-fab'));
      await testHelpers.waitAndType(
        by.id('expense-title-input'),
        'Network Test',
      );
      await testHelpers.waitAndType(by.id('expense-amount-input'), '100.00');

      // Save should succeed (local storage)
      await testHelpers.waitAndTap(by.id('save-expense-button'));
      await testHelpers.verifyExpenseInList('Network Test', '100.00');

      // Data should persist across app restart
      await device.terminateApp();
      await device.launchApp();
      await testHelpers.expectVisible(by.text('Network Test'));
    });

    it('should provide helpful validation messages', async () => {
      // Test comprehensive form validation
      await testHelpers.waitAndTap(by.id('add-expense-fab'));

      // Try to save empty form
      await testHelpers.waitAndTap(by.id('save-expense-button'));
      await testHelpers.expectVisible(by.text('Title is required'));
      await testHelpers.expectVisible(by.text('Amount must be greater than 0'));

      // Add title, invalid amount
      await testHelpers.waitAndType(by.id('expense-title-input'), 'Test');
      await testHelpers.waitAndType(by.id('expense-amount-input'), '0');
      await testHelpers.waitAndTap(by.id('save-expense-button'));
      await testHelpers.expectVisible(by.text('Amount must be greater than 0'));

      // Fix amount, should work
      await testHelpers.waitAndReplace(by.id('expense-amount-input'), '10.00');
      await testHelpers.waitAndTap(by.id('save-expense-button'));
      await testHelpers.verifyExpenseInList('Test', '10.00');
    });

    it('should handle username validation comprehensively', async () => {
      await testHelpers.waitAndTap(by.text('Settings'));

      // Test various invalid usernames
      const invalidUsernames = [
        { input: '', error: 'Username is required' },
        { input: 'a', error: 'Username must be at least 2 characters' },
        {
          input: 'a'.repeat(31),
          error: 'Username must be 30 characters or less',
        },
        {
          input: 'user@name',
          error:
            'Username can only contain letters, numbers, underscores, and hyphens',
        },
        { input: 'admin', error: 'Username is reserved' },
      ];

      for (const test of invalidUsernames) {
        await testHelpers.waitAndReplace(by.id('username-input'), test.input);
        await testHelpers.waitAndTap(by.text('Save Settings'));
        await testHelpers.expectVisible(by.text(test.error));
      }

      // Valid username should work
      await testHelpers.waitAndReplace(by.id('username-input'), 'validuser123');
      await testHelpers.waitAndTap(by.text('Save Settings'));
      await testHelpers.expectVisible(by.text('Settings saved successfully'));
    });
  });
});
