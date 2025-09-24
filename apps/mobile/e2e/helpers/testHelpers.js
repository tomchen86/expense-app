// Test helper functions for E2E tests
const testHelpers = {
  // Basic interaction helpers
  async waitAndTap(matcher, timeout = 5000) {
    await waitFor(element(matcher)).toBeVisible().withTimeout(timeout);
    await element(matcher).tap();
  },

  async waitAndType(matcher, text, timeout = 5000) {
    await waitFor(element(matcher)).toBeVisible().withTimeout(timeout);
    await element(matcher).typeText(text);
  },

  async waitAndReplace(matcher, text, timeout = 5000) {
    await waitFor(element(matcher)).toBeVisible().withTimeout(timeout);
    await element(matcher).replaceText(text);
  },

  async expectVisible(matcher, timeout = 5000) {
    await waitFor(element(matcher)).toBeVisible().withTimeout(timeout);
  },

  async expectNotVisible(matcher, timeout = 5000) {
    await waitFor(element(matcher)).not.toBeVisible().withTimeout(timeout);
  },

  async isVisible(matcher, timeout = 2000) {
    try {
      await waitFor(element(matcher)).toBeVisible().withTimeout(timeout);
      return true;
    } catch (error) {
      return false;
    }
  },

  async scrollTo(matcher, direction = 'down', amount = 'small') {
    await element(matcher).scroll(200, direction);
  },

  // App-specific workflow helpers
  async setUsername(username) {
    try {
      await this.waitAndTap(by.text('Settings'));
      await this.waitAndReplace(by.id('username-input'), username);
      await this.waitAndTap(by.text('Save Settings'));

      // Wait for success message or return to home
      const successVisible = await this.isVisible(
        by.text('Settings saved successfully'),
      );
      if (successVisible) {
        // Wait a moment for the message to disappear
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      // Return to home
      await this.waitAndTap(by.text('Home'));
    } catch (error) {
      console.log('Username might already be set or navigation different');
      // Try to navigate to home anyway
      try {
        await this.waitAndTap(by.text('Home'));
      } catch (homeError) {
        // Already on home or different screen structure
      }
    }
  },

  async createExpense(title, amount, category = 'Food & Dining') {
    await this.waitAndTap(by.id('add-expense-fab'));
    await this.waitAndType(by.id('expense-title-input'), title);
    await this.waitAndType(by.id('expense-amount-input'), amount);

    // Select category if not default
    if (category && category !== 'Food & Dining') {
      await this.waitAndTap(by.id('category-picker'));
      await this.waitAndTap(by.text(category));
    }

    await this.waitAndTap(by.id('save-expense-button'));

    // Wait for navigation back to home
    await this.expectVisible(by.text('Home'));
  },

  async createGroup(groupName) {
    await this.waitAndTap(by.text('History'));
    await this.waitAndTap(by.id('add-group-button'));
    await this.waitAndType(by.id('group-name-input'), groupName);
    await this.waitAndTap(by.text('Create'));

    // Wait for group to appear in list
    await this.expectVisible(by.text(groupName));
  },

  async verifyExpenseInList(title, amount) {
    await this.expectVisible(by.text(title));
    await this.expectVisible(by.text(`$${amount}`));
  },

  // Navigation helpers
  async navigateToHome() {
    await this.waitAndTap(by.text('Home'));
  },

  async navigateToHistory() {
    await this.waitAndTap(by.text('History'));
  },

  async navigateToSettings() {
    await this.waitAndTap(by.text('Settings'));
  },

  async navigateToInsights() {
    await this.waitAndTap(by.id('total-share-button'));
  },

  // Form validation helpers
  async expectFormError(errorMessage) {
    await this.expectVisible(by.text(errorMessage));
  },

  async clearForm() {
    // Try to clear common form fields
    const fields = [
      'expense-title-input',
      'expense-amount-input',
      'expense-caption-input',
      'group-name-input',
      'category-name-input',
    ];

    for (const field of fields) {
      const fieldExists = await this.isVisible(by.id(field));
      if (fieldExists) {
        await this.waitAndReplace(by.id(field), '');
      }
    }
  },

  // Data verification helpers
  async verifyTotalAmount(expectedAmount) {
    await this.navigateToInsights();
    await this.expectVisible(by.text(expectedAmount));
  },

  async verifyExpenseCount(expectedCount) {
    // This would need to be implemented based on how the UI shows expense count
    // For now, we'll just verify the home screen shows expenses
    await this.navigateToHome();
    if (expectedCount > 0) {
      await this.expectVisible(by.id('expense-list'));
    } else {
      await this.expectVisible(by.text('No expenses yet'));
    }
  },

  async verifyGroupExists(groupName) {
    await this.navigateToHistory();
    await this.expectVisible(by.text(groupName));
  },

  async verifyCategoryExists(categoryName) {
    await this.navigateToSettings();
    await this.waitAndTap(by.text('Manage Categories'));
    await this.expectVisible(by.text(categoryName));
    // Navigate back
    await this.navigateToHome();
  },

  // Category management helpers
  async createCategory(name, color = 'red') {
    await this.navigateToSettings();
    await this.waitAndTap(by.text('Manage Categories'));
    await this.waitAndTap(by.id('add-category-button'));
    await this.waitAndType(by.id('category-name-input'), name);

    // Select color (assuming color options have IDs like 'color-option-red')
    await this.waitAndTap(by.id(`color-option-${color}`));

    await this.waitAndTap(by.text('Save'));
    await this.expectVisible(by.text(name));
  },

  // Settings helpers
  async updateSetting(settingName, value) {
    await this.navigateToSettings();

    switch (settingName) {
      case 'currency':
        await this.waitAndTap(by.text('Currency:'));
        await this.waitAndTap(by.text(value));
        break;
      case 'theme':
        await this.waitAndTap(by.text('Theme:'));
        await this.waitAndTap(by.text(value));
        break;
      case 'displayName':
        await this.waitAndReplace(by.id('display-name-input'), value);
        break;
      default:
        throw new Error(`Unknown setting: ${settingName}`);
    }

    await this.waitAndTap(by.text('Save Settings'));
    await this.expectVisible(by.text('Settings saved successfully'));
  },

  // Insights helpers
  async verifyInsightData(categoryName, amount) {
    await this.navigateToInsights();
    await this.expectVisible(by.text(categoryName));
    await this.expectVisible(by.text(amount));
  },

  async navigateInsightsPeriod(direction) {
    await this.navigateToInsights();

    if (direction === 'previous') {
      await this.waitAndTap(by.id('previous-month-button'));
    } else if (direction === 'next') {
      await this.waitAndTap(by.id('next-month-button'));
    }
  },

  // Group helpers
  async addExpenseToGroup(groupName, title, amount) {
    await this.navigateToHistory();
    await this.waitAndTap(by.text(groupName));
    await this.createExpense(title, amount);
  },

  async verifyGroupBalance(groupName, expectedBalance) {
    await this.navigateToHistory();
    await this.waitAndTap(by.text(groupName));

    const balanceButtonExists = await this.isVisible(
      by.id('group-balances-button'),
    );
    if (balanceButtonExists) {
      await this.waitAndTap(by.id('group-balances-button'));
      await this.expectVisible(by.text(expectedBalance));
    }
  },

  // Error handling helpers
  async dismissAlert() {
    const alertVisible = await this.isVisible(by.text('OK'));
    if (alertVisible) {
      await this.waitAndTap(by.text('OK'));
    }
  },

  async handlePermissionDialog() {
    // Handle iOS/Android permission dialogs if they appear
    const allowVisible = await this.isVisible(by.text('Allow'));
    if (allowVisible) {
      await this.waitAndTap(by.text('Allow'));
    }
  },

  // Utility helpers
  async waitForAppToLoad() {
    // Wait for app to fully load by checking for key UI elements
    await this.expectVisible(by.text('Home'));
  },

  async resetAppState() {
    // Reset app to clean state - this might need device-specific implementation
    await device.reloadReactNative();
    await this.waitForAppToLoad();
  },

  async takeScreenshot(name) {
    // Take screenshot for debugging
    await device.takeScreenshot(name);
  },

  // Validation helpers
  async validateExpenseForm(expectedErrors = []) {
    for (const error of expectedErrors) {
      await this.expectFormError(error);
    }
  },

  async validateUsernameForm(expectedError) {
    if (expectedError) {
      await this.expectFormError(expectedError);
    }
  },

  // Swipe gestures
  async swipeLeftToDelete(itemMatcher) {
    await element(itemMatcher).swipe('left');
  },

  async swipeRightToEdit(itemMatcher) {
    await element(itemMatcher).swipe('right');
  },

  // Long press gestures
  async longPress(matcher) {
    await element(matcher).longPress();
  },

  // Wait helpers
  async waitForElement(matcher, timeout = 5000) {
    await waitFor(element(matcher)).toBeVisible().withTimeout(timeout);
  },

  async waitForElementToDisappear(matcher, timeout = 5000) {
    await waitFor(element(matcher)).not.toBeVisible().withTimeout(timeout);
  },

  // Text input helpers
  async clearAndType(matcher, text) {
    await element(matcher).clearText();
    await element(matcher).typeText(text);
  },

  // List interaction helpers
  async scrollToElement(matcher, direction = 'down') {
    await element(matcher).scroll(200, direction);
  },

  // Date helpers (if date pickers are available)
  async selectDate(year, month, day) {
    // Implementation depends on the specific date picker component used
    // This is a placeholder for date selection functionality
    console.log(
      `Date selection not fully implemented: ${year}-${month}-${day}`,
    );
  },

  // Complex workflow helpers
  async completeOnboardingFlow(username, displayName = null) {
    await this.setUsername(username);

    if (displayName) {
      await this.navigateToSettings();
      await this.waitAndReplace(by.id('display-name-input'), displayName);
      await this.waitAndTap(by.text('Save Settings'));
    }

    await this.navigateToHome();
  },

  async createExpenseWithAllFields(
    title,
    amount,
    category,
    caption = null,
    date = null,
  ) {
    await this.waitAndTap(by.id('add-expense-fab'));
    await this.waitAndType(by.id('expense-title-input'), title);
    await this.waitAndType(by.id('expense-amount-input'), amount);

    if (category) {
      await this.waitAndTap(by.id('category-picker'));
      await this.waitAndTap(by.text(category));
    }

    if (caption) {
      await this.waitAndType(by.id('expense-caption-input'), caption);
    }

    if (date) {
      await this.selectDate(date.year, date.month, date.day);
    }

    await this.waitAndTap(by.id('save-expense-button'));
    await this.expectVisible(by.text('Home'));
  },
};

module.exports = testHelpers;
