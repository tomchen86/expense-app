# Mobile Integration Tests Summary

_Last updated: September 30, 2025_

## Overview

The React Native Expo mobile app has **2 integration test files** covering **Screen-level workflows**. The integration test suite validates complete user flows, store integration, and cross-component interactions across 23 test cases.

## Test Philosophy

Integration tests focus on:

- **Complete Workflows**: Testing entire user journeys from start to finish
- **Store Integration**: Validating real Zustand store operations (not mocked)
- **Cross-Component Interactions**: Testing how components work together
- **Real State Management**: Using actual store state, not test fixtures
- **User Experience Validation**: Ensuring workflows match user expectations

**Router Testing Strategy**: These integration tests use mocked `expo-router` for navigation. For tests requiring actual navigation flows, see [EXPO_ROUTER_TESTING_ANALYSIS.md](./EXPO_ROUTER_TESTING_ANALYSIS.md) for guidance on using `renderRouter` (ISS-106).

## Key Differences from Unit Tests

| Aspect           | Unit Tests                | Integration Tests         |
| ---------------- | ------------------------- | ------------------------- |
| **Scope**        | Single function/component | Complete workflow         |
| **Dependencies** | Mocked                    | Real (store, navigation)  |
| **Focus**        | Logic correctness         | User experience           |
| **Speed**        | Fast (< 3s)               | Slower (> 5s)             |
| **Setup**        | Minimal                   | Full store initialization |

## Integration Test Files

### SettingsScreen.integration.test.ts

**Test Suite**: `SettingsScreen Integration`

**Purpose**: Validates complete user onboarding, settings management, and cross-store synchronization workflows.

#### Test Cases:

1. **`should complete new user onboarding flow`**
   - **Behavior**: Tests complete user setup workflow from first launch
   - **Validates**:
     - User creation via store
     - Display name setting and persistence
     - Navigation to settings after setup
   - **Stores Involved**: userStore, participantStore
   - **User Journey**: First launch → Enter name → Save → View settings

2. **`should validate display name requirements during setup`**
   - **Behavior**: Validates display name input during onboarding
   - **Validates**:
     - Minimum length requirements (3 chars)
     - Maximum length limits (50 chars)
     - Unicode character support (emoji, international names)
     - Empty string rejection
   - **Stores Involved**: userStore
   - **User Journey**: Setup screen → Invalid input → Error message → Valid input → Success

3. **`should handle settings persistence workflow`**
   - **Behavior**: Tests settings save and persistence across sessions
   - **Validates**:
     - Settings update via store
     - Data persistence (simulated storage)
     - Settings retrieval after save
     - Default values preservation
   - **Stores Involved**: userStore
   - **User Journey**: Settings screen → Change setting → Save → Reload → Verify persistence

4. **`should create group after username setup`**
   - **Behavior**: Tests group creation workflow requiring user setup
   - **Validates**:
     - User existence check before group creation
     - User automatically added as group participant
     - Group creation through composedExpenseStore
   - **Stores Involved**: userStore, groupStore, participantStore, composedExpenseStore
   - **User Journey**: Complete user setup → Create group → User auto-added as participant

5. **`should require user before group creation`**
   - **Behavior**: Validates user setup requirement for group operations
   - **Validates**:
     - Group creation blocked without user setup
     - Error handling for missing user
     - Navigation to settings when user missing
   - **Stores Involved**: userStore, groupStore
   - **User Journey**: No user → Attempt group creation → Error → Redirect to settings

6. **`should handle participant management in groups`**
   - **Behavior**: Tests complete participant addition workflow
   - **Validates**:
     - Participant creation via store
     - Participant addition to specific group
     - Duplicate prevention
     - Group participant list updates
   - **Stores Involved**: groupStore, participantStore, composedExpenseStore
   - **User Journey**: View group → Add participant → Enter name → Save → Participant appears in list

7. **`should handle theme switching`**
   - **Behavior**: Tests theme toggle functionality and persistence
   - **Validates**:
     - Theme state update in userStore
     - Settings persistence with new theme
     - Theme application across app (visual state)
   - **Stores Involved**: userStore
   - **User Journey**: Settings → Toggle theme → Save → Theme applied

8. **`should handle currency settings`**
   - **Behavior**: Tests currency setting changes and formatting updates
   - **Validates**:
     - Currency selection update
     - Settings persistence
     - Currency format application in calculations
   - **Stores Involved**: userStore
   - **User Journey**: Settings → Select currency → Save → Currency format updates

9. **`should handle date format preferences`**
   - **Behavior**: Tests date format setting changes
   - **Validates**:
     - Date format selection (US, EU, ISO)
     - Settings persistence
     - Date display format application
   - **Stores Involved**: userStore
   - **User Journey**: Settings → Select date format → Save → Date format updates

10. **`should validate settings before saving`**
    - **Behavior**: Validates settings integrity before persistence
    - **Validates**:
      - All required fields present
      - Valid field values (enums, ranges)
      - Error reporting for invalid settings
    - **Stores Involved**: userStore
    - **User Journey**: Settings → Invalid value → Save attempt → Validation error

11. **`should handle unsaved changes warning`**
    - **Behavior**: Tests unsaved changes detection on navigation
    - **Validates**:
      - Dirty state detection (form modified)
      - Navigation option changes (Cancel/Save buttons)
      - State comparison (current vs saved)
    - **Stores Involved**: userStore
    - **User Journey**: Settings → Make changes → Back button → Warning → Confirm/Cancel

12. **`should handle save confirmation workflow`**
    - **Behavior**: Tests save confirmation dialog workflow
    - **Validates**:
      - Confirmation dialog display
      - Save action on confirm
      - Discard action on cancel
      - Navigation after save
    - **Stores Involved**: userStore
    - **User Journey**: Settings → Changes → Save → Confirm → Settings persisted

13. **`should handle settings migration on load`**
    - **Behavior**: Tests settings migration during app load
    - **Validates**:
      - Legacy settings format detection
      - Migration to current format
      - Default value application for new fields
      - Version number updates
    - **Stores Involved**: userStore
    - **User Journey**: App launch with old settings → Automatic migration → Current format

### AddExpenseScreen.integration.test.ts

**Test Suite**: `AddExpenseScreen Integration`

**Purpose**: Validates complete expense creation, editing, and store integration workflows.

#### Test Cases:

1. **`should complete full expense creation flow`**
   - **Behavior**: Tests complete expense creation from empty form to store persistence
   - **Validates**:
     - Form field population (amount, description, category, date)
     - Expense creation via expenseStore
     - Navigation back to home screen
     - New expense appears in expense list
   - **Stores Involved**: expenseStore, categoryStore, userStore
   - **User Journey**: Add button → Fill form → Save → Return to home → Expense visible

2. **`should handle group expense assignment`**
   - **Behavior**: Tests expense assignment to groups with participant selection
   - **Validates**:
     - Group selection from available groups
     - Payer selection from group participants
     - Participant selection for split
     - Expense created with group context
   - **Stores Involved**: expenseStore, groupStore, participantStore
   - **User Journey**: Add expense → Select group → Select payer → Select split participants → Save

3. **`should validate required fields`**
   - **Behavior**: Validates form fields before expense creation
   - **Validates**:
     - Amount required and > 0
     - Category required
     - Date required and valid
     - Description optional
     - Error messages for each field
   - **Stores Involved**: None (form validation only)
   - **User Journey**: Add expense → Leave fields empty → Save attempt → Validation errors

4. **`should integrate with store correctly`**
   - **Behavior**: Tests store integration with multiple expenses
   - **Validates**:
     - Multiple expense creation
     - Store state consistency
     - Expense ordering (newest first)
     - No data corruption between operations
   - **Stores Involved**: expenseStore
   - **User Journey**: Create expense 1 → Create expense 2 → Verify both in store

5. **`should handle navigation back on successful save`**
   - **Behavior**: Tests navigation after successful expense save
   - **Validates**:
     - Navigation to previous screen (home or group detail)
     - Navigation params cleared
     - Form reset after navigation
   - **Stores Involved**: expenseStore
   - **User Journey**: Add expense → Fill form → Save → Navigate back → Verify location

6. **`should maintain form state during category selection`**
   - **Behavior**: Tests form state preservation during modal interactions
   - **Validates**:
     - Form data preserved when category modal opens
     - Category selection updates form
     - Other fields remain unchanged
     - Modal close preserves all data
   - **Stores Involved**: categoryStore
   - **User Journey**: Fill form → Open category modal → Select category → Close modal → Verify form state

7. **`should handle form reset after successful submission`**
   - **Behavior**: Tests form cleanup after expense creation
   - **Validates**:
     - All form fields cleared
     - Initial state restored
     - Modal states reset
     - Form ready for next expense
   - **Stores Involved**: expenseStore
   - **User Journey**: Create expense → Save → Return to add expense → Verify empty form

8. **`should load available categories`**
   - **Behavior**: Tests category loading for form selection
   - **Validates**:
     - Category list loaded from categoryStore
     - Default categories available
     - Custom categories included
     - Categories sorted properly
   - **Stores Involved**: categoryStore
   - **User Journey**: Open add expense → Category picker → Verify categories loaded

9. **`should load available groups for expense assignment`**
   - **Behavior**: Tests group loading for expense assignment
   - **Validates**:
     - Group list loaded from groupStore
     - User's groups available
     - Groups with participants only
     - No group option available
   - **Stores Involved**: groupStore
   - **User Journey**: Open add expense → Group picker → Verify groups loaded

10. **`should handle expense assignment to specific group`**
    - **Behavior**: Tests specific group assignment workflow
    - **Validates**:
      - Group selection from list
      - Group context applied to expense
      - Expense visible in group detail screen
      - Group totals updated
    - **Stores Involved**: expenseStore, groupStore
    - **User Journey**: Add expense → Select group → Save → View group detail → Expense in group

## Integration Test Patterns

### 1. Store Setup Pattern

```typescript
// Integration tests use real stores, not mocks
beforeEach(() => {
  const store = useExpenseStore.getState();
  // Initialize with realistic data
  store.addExpense(validExpense);
});
```

### 2. Complete Workflow Pattern

```typescript
// Test entire user journey
it('should complete expense creation flow', async () => {
  // 1. Setup initial state
  // 2. Trigger user action
  // 3. Validate intermediate states
  // 4. Verify final state
  // 5. Check side effects
});
```

### 3. Cross-Store Validation Pattern

```typescript
// Verify data consistency across multiple stores
const expense = expenseStore.getState().expenses[0];
const group = groupStore.getState().getGroupById(expense.groupId);
expect(group.expenses).toContain(expense.id);
```

### 4. Navigation Testing Pattern

```typescript
// Validate navigation flows
const { navigate, goBack } = mockNavigation;
expect(navigate).toHaveBeenCalledWith('AddExpenseScreen');
expect(goBack).toHaveBeenCalled();
```

## Test Data Management

### Fixtures Used in Integration Tests

```typescript
// Valid test data for realistic scenarios
const validExpense = {
  id: 'expense-1',
  amount: 25.5,
  description: 'Lunch',
  category: 'Food',
  date: new Date().toISOString(),
};

const validGroup = {
  id: 'group-1',
  name: 'Roommates',
  participants: ['user-1', 'user-2'],
};

const mockUser = {
  internalUserId: 'user-1',
  displayName: 'Test User',
};
```

## Common Assertions

### Store State Assertions

```typescript
// Verify expense was added
expect(store.expenses).toHaveLength(1);
expect(store.expenses[0]).toMatchObject(validExpense);

// Verify cross-store synchronization
const participant = participantStore.getById(userId);
expect(participant.displayName).toBe(user.displayName);
```

### Navigation Assertions

```typescript
// Verify navigation occurred
expect(mockNavigation.navigate).toHaveBeenCalledWith('HomeScreen');
expect(mockNavigation.goBack).toHaveBeenCalled();
```

### Form State Assertions

```typescript
// Verify form reset
expect(form.amount).toBe('');
expect(form.description).toBe('');
expect(form.category).toBe(null);
```

## Performance Considerations

Integration tests are slower than unit tests due to:

1. **Real Store Operations**: Actual Zustand state updates
2. **Component Rendering**: Full component trees
3. **Async Operations**: State updates and navigation
4. **Setup Complexity**: Multiple store initialization

**Typical Timing**:

- Unit test: 10-50ms
- Integration test: 100-500ms

## Best Practices

### 1. Test Real User Flows

```typescript
// ✅ Good - Tests complete workflow
it('should create and view expense', async () => {
  await createExpense();
  navigateToHome();
  expect(expenseIsVisible()).toBe(true);
});

// ❌ Bad - Tests isolated action
it('should add expense', () => {
  store.addExpense(expense);
});
```

### 2. Use Realistic Test Data

```typescript
// ✅ Good - Realistic data
const expense = {
  amount: 25.5, // Real currency
  date: new Date(), // Real date
  category: 'Food', // Valid category
};

// ❌ Bad - Unrealistic data
const expense = {
  amount: 999999,
  date: 'invalid',
  category: 'test',
};
```

### 3. Validate Cross-Store Consistency

```typescript
// ✅ Good - Checks data consistency
const expense = expenseStore.getExpense(id);
const group = groupStore.getGroup(expense.groupId);
expect(group.totalAmount).toBe(calculateTotal(group.expenses));

// ❌ Bad - Only checks one store
expect(expenseStore.expenses).toHaveLength(1);
```

### 4. Clean Up After Tests

```typescript
afterEach(() => {
  // Reset all stores to clean state
  useExpenseStore.getState().reset();
  useGroupStore.getState().reset();
  useUserStore.getState().reset();
});
```

## Summary Statistics

### Test Coverage:

- **Integration Test Files**: 2 files
- **Total Test Cases**: 23 tests
- **Screens Covered**: SettingsScreen, AddExpenseScreen
- **Stores Validated**: expenseStore, groupStore, categoryStore, participantStore, userStore, composedExpenseStore

### Store Integration Coverage:

| Store                    | Tests Covering | Integration Depth                |
| ------------------------ | -------------- | -------------------------------- |
| **userStore**            | 13 tests       | Settings, onboarding, sync       |
| **expenseStore**         | 10 tests       | Creation, editing, retrieval     |
| **groupStore**           | 6 tests        | Creation, participant management |
| **categoryStore**        | 3 tests        | Loading, selection               |
| **participantStore**     | 6 tests        | Creation, group membership       |
| **composedExpenseStore** | 4 tests        | Cross-store operations           |

### Key Characteristics:

- **Real Store Operations**: No mocked store functions
- **Complete Workflows**: End-to-end user journeys
- **Cross-Store Validation**: Data consistency checks
- **Navigation Testing**: Screen transition validation
- **Error Handling**: Invalid input and edge case testing
- **State Persistence**: Simulated storage operations

### Testing Technologies:

- **React Native Testing Library**: Component rendering and interaction
- **Zustand**: Real store operations (not mocked)
- **Jest**: Test framework and assertions
- **Mock Navigation**: Simulated Expo Router navigation
- **TypeScript**: Type-safe test definitions

## Future Integration Test Opportunities

### Recommended Additional Coverage:

1. **GroupDetailScreen Integration**
   - Complete group expense workflow
   - Participant balance calculations
   - Settlement suggestions

2. **InsightsScreen Integration**
   - Period navigation with data filtering
   - Chart rendering with real data
   - Category breakdown calculations

3. **ExpenseEditScreen Integration**
   - Expense update workflow
   - Form pre-population
   - Category and group changes

4. **Multi-Screen Workflows**
   - Home → Add Expense → Category Management → Back
   - Settings → Create Group → Add Participant → Add Expense
   - History → Group Detail → Add Expense → View in Home

5. **Error Recovery Workflows**
   - Network failure handling (future API integration)
   - Validation error recovery
   - Navigation error handling
