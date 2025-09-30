# E2E Test ID Mapping

This document maps test IDs required by E2E tests to their corresponding components.

## Required Test IDs

### Home Screen & FAB

- `add-expense-fab` → `src/components/FloatingActionButton.tsx`
- `expense-list` → `src/screens/HomeScreen.tsx` (FlatList)
- `total-share-button` → `src/screens/HomeScreen.tsx` (Insights button)

### Add Expense Form

- `expense-title-input` → `src/components/ExpenseForm/BasicInfoSection.tsx`
- `expense-amount-input` → `src/components/ExpenseForm/BasicInfoSection.tsx`
- `expense-caption-input` → `src/components/ExpenseForm/BasicInfoSection.tsx`
- `category-picker` → `src/components/ExpenseForm/BasicInfoSection.tsx` or `src/components/SelectInput.tsx`
- `save-expense-button` → `src/screens/AddExpenseScreen.tsx`
- `date-picker` → `src/components/DatePicker.tsx`

### Group Management

- `add-group-button` → `src/screens/HistoryScreen.tsx`
- `group-name-input` → `src/components/TextInputModal.tsx` (group creation modal)
- `group-tag` → `src/components/ExpenseListItem.tsx` (group indicator)
- `group-balances-button` → `src/screens/GroupDetailScreen.tsx`

### Category Management

- `add-category-button` → `src/screens/ManageCategoriesScreen.tsx`
- `category-name-input` → `src/components/categories/CategoryForm.tsx`
- `color-option-blue` → `src/components/categories/ColorPicker.tsx`
- `color-option-green` → `src/components/categories/ColorPicker.tsx`
- (Add more color options as needed)

### Settings Screen

- `username-input` → `src/screens/SettingsScreen.tsx`
- `display-name-input` → `src/screens/SettingsScreen.tsx`

### Insights Screen

- `pie-chart` → `src/components/insights/CategoryChart.tsx`
- `previous-month-button` → `src/components/insights/InsightsHeader.tsx`
- `next-month-button` → `src/components/insights/InsightsHeader.tsx`
- `date-period-selector` → `src/components/insights/DatePickerModal.tsx`

## Implementation Priority

### Phase 1: Critical Path (Must have for first E2E test)

1. ✅ `add-expense-fab` - Home screen FAB
2. ✅ `expense-title-input` - Expense title field
3. ✅ `expense-amount-input` - Expense amount field
4. ✅ `category-picker` - Category selection
5. ✅ `save-expense-button` - Save button

### Phase 2: User Onboarding

6. ✅ `username-input` - Settings username
7. ✅ `add-group-button` - Group creation

### Phase 3: Full Coverage

8. All remaining test IDs

## Testing Strategy

After adding testIDs:

1. Build iOS app for simulator
2. Run simplified E2E test (expense creation only)
3. Debug and iterate
4. Add remaining testIDs
5. Run full E2E test suite
