# Mobile E2E Tests (Detox)

_Last updated: September 30, 2025_

## Overview

The mobile app uses **Detox v20.42.0** for End-to-End testing on real devices and simulators. This document covers:

- Complete E2E test scenarios (62 tests across 3 files)
- TestID mapping for component identification
- Test infrastructure and configuration
- Status and next steps

**Current Status**: 🚧 Infrastructure complete, iOS build pending

---

## E2E Test Suites

### 1. expenseFlow.test.js (20+ tests)

**Test Suite**: `Expense Management Flow`

#### New User Onboarding (2 tests)

1. **`should complete new user expense journey`**
   - **Behavior**: Tests complete first-time user workflow from username setup to expense creation
   - **Validates**: Username setup, navigation, expense form completion, category selection, expense persistence in list

2. **`should handle username requirement for group creation`**
   - **Behavior**: Tests username validation workflow for group features
   - **Validates**: Group creation blocked without username, navigation to settings, username setup, successful group creation after setup

#### Expense Management (3 tests)

3. **`should create, edit, and delete expense`**
   - **Behavior**: Tests complete CRUD operations on expenses
   - **Validates**: Expense creation, editing via tap, field modification, save persistence, swipe-to-delete functionality

4. **`should validate expense form inputs`**
   - **Behavior**: Tests comprehensive form validation with various invalid inputs
   - **Validates**: Required field validation, amount validation (negative/zero), error message display, successful save after correction

5. **`should create expense with optional caption`**
   - **Behavior**: Tests optional field handling in expense creation
   - **Validates**: Caption field functionality, persistence, display in expense list

#### Group Management (3 tests)

6. **`should create and manage group expense`**
   - **Behavior**: Tests group-based expense management workflow
   - **Validates**: Group creation, group expense assignment, group tag display, expense-to-group association

7. **`should show group insights and totals`**
   - **Behavior**: Tests group analytics and calculation features
   - **Validates**: Multiple group expenses, pie chart display, expense breakdown, total calculation accuracy ($250.00)

8. **`should calculate participant balances`**
   - **Behavior**: Tests expense splitting and balance calculation
   - **Validates**: Group balance display, participant identification, split calculation (assuming equal split: $30.00 from $60.00)

#### Category Management (3 tests)

9. **`should create, edit, and delete categories`**
   - **Behavior**: Tests complete category lifecycle management
   - **Validates**: Category creation with color selection, editing, name updates, swipe-to-delete functionality

10. **`should not allow deleting default "Other" category`**
    - **Behavior**: Tests protection of essential system categories
    - **Validates**: Default category protection, swipe action handling on protected categories

11. **`should use new category in expense creation`**
    - **Behavior**: Tests category creation to usage workflow
    - **Validates**: Category creation, category availability in expense form, expense creation with custom category

#### Insights and Analytics (3 tests)

12. **`should navigate insights and view analytics`**
    - **Behavior**: Tests comprehensive analytics feature with multiple data points
    - **Validates**: Pie chart display, category breakdown, time period navigation, date picker functionality

13. **`should handle empty insights gracefully`**
    - **Behavior**: Tests analytics behavior with no data
    - **Validates**: Empty state message display, graceful handling of no expense data

14. **`should filter insights by time period`**
    - **Behavior**: Tests time-based filtering and navigation
    - **Validates**: Current month data display, previous/next month navigation, data filtering by time period

#### Data Persistence (1 test)

15. **`should persist data across app restarts`**
    - **Behavior**: Tests data persistence through app lifecycle
    - **Validates**: Expense persistence after app restart, username persistence, data integrity across sessions

#### Error Handling (2 tests)

16. **`should handle invalid expense amounts gracefully`**
    - **Behavior**: Tests comprehensive amount validation with various invalid inputs
    - **Validates**: Invalid amount handling (abc, 0, -10, empty, whitespace), error state management, valid amount acceptance

17. **`should handle empty group name validation`**
    - **Behavior**: Tests group creation validation
    - **Validates**: Empty name validation, error message display, successful creation with valid name

---

### 2. userOnboarding.e2e.js (17 tests)

**Test Suite**: `User Onboarding Journey`

#### First Time User Experience (3 tests)

1. **`should complete first-time user setup`**
   - **Behavior**: Tests virgin app state and initial user journey
   - **Validates**: Home screen empty state, first expense creation, category selection, expense persistence, total display

2. **`should guide user through username setup for groups`**
   - **Behavior**: Tests progressive disclosure of group features
   - **Validates**: Username requirement dialog, settings navigation, username entry, group creation workflow completion

3. **`should require username for group features only`**
   - **Behavior**: Tests feature access control based on setup completion
   - **Validates**: Individual expense creation without username, insights access, category management access, group feature blocking

#### Progressive Feature Discovery (3 tests)

4. **`should guide through first group creation`**
   - **Behavior**: Tests first-time group creation experience
   - **Validates**: Empty groups state, group creation, helpful messaging, group detail view

5. **`should introduce insights after sufficient data`**
   - **Behavior**: Tests analytics feature with meaningful data
   - **Validates**: Multiple expense creation, rich analytics display, category totals, period navigation

6. **`should handle category customization workflow`**
   - **Behavior**: Tests discovery and use of category management
   - **Validates**: Category picker exploration, settings navigation, custom category creation, usage in expense creation

#### Data Migration and Settings (2 tests)

7. **`should handle settings preferences setup`**
   - **Behavior**: Tests settings configuration and persistence
   - **Validates**: Default settings display, currency changes, theme switching, settings persistence across navigation

8. **`should handle display name setup`**
   - **Behavior**: Tests user profile management
   - **Validates**: Display name entry, settings persistence, display name usage in group context

#### Error Recovery and Help (3 tests)

9. **`should handle network-like errors gracefully`**
   - **Behavior**: Tests data persistence and local storage reliability
   - **Validates**: Expense save success, data persistence across app restart, local storage functionality

10. **`should provide helpful validation messages`**
    - **Behavior**: Tests comprehensive form validation messaging
    - **Validates**: Empty form validation, progressive error correction, helpful error messages

11. **`should handle username validation comprehensively`**
    - **Behavior**: Tests username field validation with edge cases
    - **Validates**: Empty username, length limits (2-30 chars), special character restrictions, reserved name prevention

---

### 3. dataValidation.e2e.js (25 tests)

**Test Suite**: `Data Validation and Consistency`

#### Cross-Screen Data Consistency (4 tests)

1. **`should persist expense across app restart`**
   - **Behavior**: Tests data persistence and cross-screen consistency
   - **Validates**: Expense creation, app restart survival, display consistency, insights integration

2. **`should sync category changes across screens`**
   - **Behavior**: Tests real-time data synchronization across app screens
   - **Validates**: Category creation, availability in expense form, insights integration, cross-screen updates

3. **`should maintain group state during navigation`**
   - **Behavior**: Tests state management during complex navigation flows
   - **Validates**: Group creation, expense assignment, navigation persistence, state consistency

4. **`should handle concurrent state updates correctly`**
   - **Behavior**: Tests rapid operations and state consistency
   - **Validates**: Multiple rapid expense creation, data integrity, accurate total calculations

#### Data Integrity Validation (4 tests)

5. **`should validate expense amount precision`**
   - **Behavior**: Tests numerical precision and rounding behavior
   - **Validates**: Various amount formats (10, 10.5, 10.99, 10.999→10.99, 0.01), proper rounding to 2 decimals

6. **`should validate date handling across time zones`**
   - **Behavior**: Tests date consistency and time zone handling
   - **Validates**: Date picker functionality, date persistence, insights consistency

7. **`should handle special characters in text fields`**
   - **Behavior**: Tests Unicode and special character support
   - **Validates**: Unicode preservation (Café ☕, Résumé, Naïve), quotes, apostrophes, emojis, special symbols

8. **`should validate category name constraints`**
   - **Behavior**: Tests category validation with boundary conditions
   - **Validates**: Category name length limits (100→50 chars), validation error handling

#### Calculation Accuracy (3 tests)

9. **`should calculate totals accurately with multiple currencies`**
   - **Behavior**: Tests financial calculation precision
   - **Validates**: Precise amount handling (33.33, 66.67, 0.01, 99.99), accurate total calculation

10. **`should handle group expense splitting correctly`**
    - **Behavior**: Tests expense splitting algorithms
    - **Validates**: Group expense creation, split calculation, balance display

11. **`should maintain calculation accuracy with large numbers`**
    - **Behavior**: Tests numerical limits and large amount handling
    - **Validates**: Large amounts (999.99, 1000.00, 9999.99), accurate summation ($11,999.98)

#### State Recovery and Error Handling (3 tests)

12. **`should recover from partial data corruption`**
    - **Behavior**: Tests app resilience and recovery capabilities
    - **Validates**: Baseline data creation, app restart recovery, continued functionality

13. **`should handle missing category gracefully`**
    - **Behavior**: Tests referential integrity and error handling
    - **Validates**: Category deletion prevention, expense-category relationship protection

14. **`should maintain data consistency during rapid operations`**
    - **Behavior**: Tests system stability under stress
    - **Validates**: Rapid CRUD operations, selective deletion, accurate calculations

#### Edge Cases and Boundary Conditions (3 tests)

15. **`should handle minimum and maximum amounts`**
    - **Behavior**: Tests numerical boundary conditions
    - **Validates**: Minimum amount (0.01), large amounts (99999.99), total calculations

16. **`should handle empty states gracefully`**
    - **Behavior**: Tests empty state handling across all screens
    - **Validates**: Home empty state, History empty state, Insights empty state

17. **`should handle date boundary conditions`**
    - **Behavior**: Tests date navigation and year boundaries
    - **Validates**: Month navigation across year boundaries, date filtering, graceful year rollover

---

## TestID Mapping

This section maps the required test IDs to their corresponding components.

### Implementation Status

**Phase 1: Critical Path** ✅ Complete (8/8)

- Essential for basic expense creation flow
- All testIDs implemented

**Phase 2-3: Full Coverage** 🚧 In Progress (0/15)

- Additional navigation and interaction elements
- Pending implementation

### Required TestIDs by Screen

#### Home Screen & FAB

- ✅ `add-expense-fab` → `src/components/FloatingActionButton.tsx`
- `expense-list` → `src/screens/HomeScreen.tsx` (FlatList)
- `total-share-button` → `src/screens/HomeScreen.tsx` (Insights button)

#### Add Expense Form

- ✅ `expense-title-input` → `src/components/ExpenseForm/BasicInfoSection.tsx`
- ✅ `expense-amount-input` → `src/components/ExpenseForm/BasicInfoSection.tsx`
- ✅ `expense-caption-input` → `src/components/ExpenseForm/BasicInfoSection.tsx`
- ✅ `category-picker` → `src/components/ExpenseForm/BasicInfoSection.tsx` (via SelectInput)
- ✅ `date-picker` → `src/components/DatePicker.tsx`
- ✅ `save-expense-button` → `src/screens/AddExpenseScreen.tsx`

#### Settings Screen

- ✅ `username-input` → `src/screens/SettingsScreen.tsx`
- `display-name-input` → `src/screens/SettingsScreen.tsx`

#### Group Management

- ✅ `add-group-button` → `src/screens/HistoryScreen.tsx`
- `group-name-input` → `src/components/TextInputModal.tsx` (group creation modal)
- `group-tag` → `src/components/ExpenseListItem.tsx` (group indicator)
- `group-balances-button` → `src/screens/GroupDetailScreen.tsx`

#### Category Management

- `add-category-button` → `src/screens/ManageCategoriesScreen.tsx`
- `category-name-input` → `src/components/categories/CategoryForm.tsx`
- `color-option-blue` → `src/components/categories/ColorPicker.tsx`
- `color-option-green` → `src/components/categories/ColorPicker.tsx`

#### Insights Screen

- `pie-chart` → `src/components/insights/CategoryChart.tsx`
- `previous-month-button` → `src/components/insights/InsightsHeader.tsx`
- `next-month-button` → `src/components/insights/InsightsHeader.tsx`
- `date-period-selector` → `src/components/insights/DatePickerModal.tsx`

---

## Test Infrastructure

### Detox Configuration (.detoxrc.js)

```javascript
module.exports = {
  testRunner: 'jest',
  runnerConfig: 'e2e/jest.config.js',
  apps: {
    'ios.debug': {
      type: 'ios.app',
      binaryPath: 'ios/build/Build/Products/Debug-iphonesimulator/mobile.app',
      build:
        'xcodebuild -workspace ios/mobile.xcworkspace -scheme mobile -configuration Debug -sdk iphonesimulator -derivedDataPath ios/build',
    },
    'android.debug': {
      type: 'android.apk',
      binaryPath: 'android/app/build/outputs/apk/debug/app-debug.apk',
      build:
        'cd android && ./gradlew assembleDebug assembleAndroidTest -DtestBuildType=debug',
    },
  },
  devices: {
    'ios.simulator': {
      type: 'ios.simulator',
      device: { type: 'iPhone 15' },
    },
    'android.emulator': {
      type: 'android.emulator',
      device: { avdName: 'Pixel_3a_API_30_x86' },
    },
  },
  configurations: {
    'ios.sim.debug': {
      device: 'ios.simulator',
      app: 'ios.debug',
    },
    'android.emu.debug': {
      device: 'android.emulator',
      app: 'android.debug',
    },
  },
};
```

**Key Points**:

- App name: `mobile` (after Expo Router migration)
- Workspace: `ios/mobile.xcworkspace`
- iOS simulator: iPhone 15
- Android emulator: Pixel 3a API 30

### Test Setup (e2e/setup.js)

**Global Helpers**:

- Custom wait/tap/type/scroll utilities
- App lifecycle management (launch, reload, terminate)
- Test data helpers (expense creation, group setup, username)
- State management (app reset, test isolation)
- Error handling (alert dismissal, graceful failures)

### Jest Configuration (e2e/jest.config.js)

```javascript
module.exports = {
  rootDir: '..',
  testMatch: ['<rootDir>/e2e/**/*.test.js'],
  testTimeout: 120000,
  maxWorkers: 1,
  globalSetup: 'detox/runners/jest/globalSetup',
  globalTeardown: 'detox/runners/jest/globalTeardown',
  reporters: ['detox/runners/jest/reporter'],
  testEnvironment: 'detox/runners/jest/testEnvironment',
  verbose: true,
};
```

---

## Running E2E Tests

### Build & Run Commands

```bash
# Build iOS app for testing
pnpm test:e2e:build -- --configuration ios.sim.debug

# Build Android app for testing
pnpm test:e2e:build -- --configuration android.emu.debug

# Run all E2E tests (iOS)
pnpm test:e2e -- --configuration ios.sim.debug

# Run all E2E tests (Android)
pnpm test:e2e -- --configuration android.emu.debug

# Run specific test file
pnpm test:e2e -- --configuration ios.sim.debug e2e/expenseFlow.test.js

# Run with debug logging
pnpm test:e2e -- --configuration ios.sim.debug --loglevel trace
```

### Prerequisites

**iOS**:

- macOS with Xcode installed
- iOS Simulator (iPhone 15)
- CocoaPods installed

**Android**:

- Android Studio with SDK
- Android Emulator (Pixel 3a API 30)
- JDK 11+

---

## Current Status & Next Steps

### ✅ Completed

1. Ejected to bare workflow (generated ios/ and android/ folders)
2. Updated Detox configuration for bare workflow
3. Added Phase 1 testIDs (8 critical components)
4. All 294 unit/integration tests still passing

### 🚧 In Progress

5. Build iOS app for simulator (~5-10 minutes)
6. Run first E2E test (expense creation flow)

### 📋 Pending

7. Add Phase 2-3 testIDs (15 remaining components)
8. Run complete E2E test suite (62 tests)
9. Add Android E2E testing
10. Integrate E2E tests into CI/CD pipeline

---

## Test Coverage Summary

### By Test Suite

- **expenseFlow.test.js**: 17 tests - Core expense workflows
- **userOnboarding.e2e.js**: 17 tests - First-time user experience
- **dataValidation.e2e.js**: 25 tests - Data integrity and edge cases

### By Feature Area

- **User Onboarding**: 11 scenarios
- **Expense Management**: 9 scenarios
- **Group Management**: 6 scenarios
- **Category Management**: 3 scenarios
- **Analytics/Insights**: 3 scenarios
- **Data Persistence**: 3 scenarios
- **Error Handling**: 6 scenarios
- **Data Validation**: 21 scenarios

### Platform Coverage

- **iOS**: iPhone 15 simulator with complete gesture support
- **Android**: Pixel 3a emulator and physical device support
- **Real Device Testing**: Both platforms support attached device testing

### Key Validation Strengths

- ✅ Complete user journeys from onboarding to advanced features
- ✅ Data persistence and cross-session integrity
- ✅ Financial accuracy with precise calculation validation
- ✅ Unicode and special character support
- ✅ Comprehensive error handling and recovery
- ✅ Performance testing with large datasets
- ✅ Accessibility through proper UI element identification

---

## Related Documentation

- **Integration Tests**: See `MOBILE_INTEGRATION_TESTS.md` for Jest integration tests
- **Unit Tests**: See `MOBILE_UNIT_TESTS.md` for component/hook unit tests
- **Router Testing**: See `EXPO_ROUTER_TESTING_ANALYSIS.md` for navigation test strategy
- **Testing Overview**: See `TESTING_OVERVIEW.md` for complete testing documentation

---

_For questions about E2E testing infrastructure or strategy, refer to this document or the TESTING_OVERVIEW.md._
