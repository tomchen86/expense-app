const { reloadApp } = require('detox');

beforeAll(async () => {
  await device.launchApp();
});

beforeEach(async () => {
  await device.reloadReactNative();
});

afterAll(async () => {
  await device.terminateApp();
});

// Global test helpers
global.sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Common test utilities
global.testHelpers = {
  // Helper to wait for element and tap
  waitAndTap: async (elementMatcher, timeout = 5000) => {
    await waitFor(element(elementMatcher))
      .toBeVisible()
      .withTimeout(timeout);
    await element(elementMatcher).tap();
  },

  // Helper to type text with wait
  waitAndType: async (elementMatcher, text, timeout = 5000) => {
    await waitFor(element(elementMatcher))
      .toBeVisible()
      .withTimeout(timeout);
    await element(elementMatcher).typeText(text);
  },

  // Helper to replace text with wait
  waitAndReplace: async (elementMatcher, text, timeout = 5000) => {
    await waitFor(element(elementMatcher))
      .toBeVisible()
      .withTimeout(timeout);
    await element(elementMatcher).replaceText(text);
  },

  // Helper to verify element is visible
  expectVisible: async (elementMatcher, timeout = 5000) => {
    await waitFor(element(elementMatcher))
      .toBeVisible()
      .withTimeout(timeout);
    await expect(element(elementMatcher)).toBeVisible();
  },

  // Helper to verify element is not visible
  expectNotVisible: async (elementMatcher, timeout = 5000) => {
    await waitFor(element(elementMatcher))
      .not.toBeVisible()
      .withTimeout(timeout);
    await expect(element(elementMatcher)).not.toBeVisible();
  },

  // Helper to scroll to element
  scrollToElement: async (scrollViewMatcher, elementMatcher, direction = 'down') => {
    await waitFor(element(elementMatcher))
      .toBeVisible()
      .whileElement(scrollViewMatcher)
      .scroll(200, direction);
  },

  // Helper to clear app state (useful for test isolation)
  clearAppState: async () => {
    await device.clearKeychain();
    await device.uninstallApp();
    await device.installApp();
    await device.launchApp();
  },

  // Helper to setup test data
  setupTestData: async () => {
    // This would typically involve creating test expenses, categories, etc.
    // For now, we'll rely on the app's default state
    console.log('Setting up test data...');
  },

  // Helper to verify expense in list
  verifyExpenseInList: async (title, amount) => {
    await expect(element(by.text(title))).toBeVisible();
    await expect(element(by.text(`$${amount}`))).toBeVisible();
  },

  // Helper to create an expense
  createExpense: async (title, amount, category = 'Food & Dining') => {
    // Navigate to add expense
    await testHelpers.waitAndTap(by.id('add-expense-fab'));

    // Fill form
    await testHelpers.waitAndType(by.id('expense-title-input'), title);
    await testHelpers.waitAndType(by.id('expense-amount-input'), amount);

    // Select category
    await testHelpers.waitAndTap(by.id('category-picker'));
    await testHelpers.waitAndTap(by.text(category));

    // Save
    await testHelpers.waitAndTap(by.id('save-expense-button'));
  },

  // Helper to set username in settings
  setUsername: async (username) => {
    await testHelpers.waitAndTap(by.text('Settings'));
    await testHelpers.waitAndReplace(by.id('username-input'), username);
    await testHelpers.waitAndTap(by.text('Save'));
    await testHelpers.expectVisible(by.text('Settings saved successfully'));
  },

  // Helper to create a group
  createGroup: async (groupName) => {
    await testHelpers.waitAndTap(by.text('History'));
    await testHelpers.waitAndTap(by.id('add-group-button'));
    await testHelpers.waitAndType(by.id('group-name-input'), groupName);
    await testHelpers.waitAndTap(by.text('Create'));
  },

  // Helper to dismiss alerts
  dismissAlert: async () => {
    try {
      await element(by.text('OK')).tap();
    } catch (e) {
      // Alert might not be present
    }
  },
};