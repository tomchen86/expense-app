# Expo Router Testing Analysis & Implementation Plan

## Executive Summary

Based on the Expo documentation review, this report outlines the testing issues encountered during our React Navigation to Expo Router migration and provides a comprehensive implementation plan to restore test coverage.

## Current Testing Issues

The migration from React Navigation to Expo Router has broken our tests because:

1. **Incorrect Mock Strategy**: Using `moduleNameMapper` for expo-router prevents integration tests from using the real router
2. **Jest Configuration**: Our current Jest config doesn't properly handle the dual testing approach (unit vs integration)
3. **Test Location**: Tests must be kept OUTSIDE the `app/` directory to avoid breaking Expo Router's file-based routing assumptions

## Documentation Analysis & Project Requirements

### From Expo Unit Testing Documentation:

- **Jest Preset**: We correctly have `jest-expo` preset configured
- **Testing Library**: We have `@testing-library/react-native` installed
- **Dependencies**: All core testing dependencies (jest, jest-expo, etc.) are present

### From Expo Router Testing Documentation:

- **Testing Library Import**: `expo-router/testing-library` is a submodule import, not a separate package
- **Custom Matchers**: Available for route assertions (`toHavePathname()`, `toHaveSegments()`, etc.)
- **File System Mocking**: Can mock route structures using `renderRouter()` with inline FS or fixtures
- **Critical Rule**: No test files inside `app/` directory - breaks routing assumptions

## Required Actions for Our Project

### BDD Scenarios

#### Scenario 1: Hook Testing with Router Functions

**Given** we have migrated from React Navigation to Expo Router
**When** we run unit tests for hooks that use router functions
**Then** tests should pass without navigation-related errors

#### Scenario 2: Component Testing with Navigation

**Given** we have components using Expo Router navigation
**When** we test these components in isolation
**Then** router functions should be properly mocked

### Implementation Plan

#### 1. Configure Jest Projects (Unit vs Integration)

```javascript
// jest.config.js - Two projects approach
module.exports = {
  preset: 'jest-expo',
  projects: [
    {
      displayName: 'unit',
      testMatch: ['<rootDir>/**/__tests__/**/*.unit.(ts|tsx)'],
      setupFilesAfterEnv: ['<rootDir>/jest.setup.unit.ts'],
      testEnvironment: 'jsdom',
    },
    {
      displayName: 'integration',
      testMatch: ['<rootDir>/**/__tests__/**/*.int.(ts|tsx)'],
      setupFilesAfterEnv: ['<rootDir>/jest.setup.int.ts'],
      testEnvironment: 'jsdom',
    },
  ],
  // DO NOT map 'expo-router' in moduleNameMapper
  transformIgnorePatterns: [
    'node_modules/(?!(?:\\.pnpm/)?((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@sentry/react-native|native-base|react-native-svg))',
  ],
};
```

#### 2. Create Router Mock for Unit Tests Only

```typescript
// __mocks__/expo-router.ts (TypeScript-safe mock for UNIT tests)
export const router = {
  push: jest.fn(),
  replace: jest.fn(),
  back: jest.fn(),
  canGoBack: jest.fn(() => true),
  setParams: jest.fn(),
  dismiss: jest.fn(),
};
export const useRouter = () => router;
export const useLocalSearchParams = jest.fn(() => ({}));
export const usePathname = jest.fn(() => '/');
export const useSegments = jest.fn(() => []);
export const Stack = { Screen: () => null };
export const Tabs = { Screen: () => null };
export const Link = () => null;
```

#### 3. Setup Files for Each Test Type

```typescript
// jest.setup.unit.ts
import '@testing-library/jest-native/extend-expect';
jest.mock('expo-router'); // uses __mocks__/expo-router.ts

// jest.setup.int.ts
import '@testing-library/jest-native/extend-expect';
// IMPORTANT: do not mock expo-router in integration tests
```

#### 4. Update Test Files

Modify failing hook tests to work with mocked router

## Project-Specific Considerations

### Our Hooks That Need Testing Updates:

- `useExpenseForm.ts` - Uses `router.back()`
- `useExpenseModals.ts` - Uses `router.push('/manage-categories')`

### Components Using Router:

- `FloatingActionButton.tsx` - Uses `router.push()`
- All screen components in `app/` directory - Use `router` and `useLocalSearchParams()`

### Test Coverage Impact:

- **Previous Coverage**: 294/294 tests were passing with React Navigation
- **Current Status**: Tests failing due to Expo Router import issues
- **Goal**: Restore full test coverage while supporting new router architecture
- **Strategy**: Router behavior should be tested through integration tests using `renderRouter()`

## Testing Strategy Recommendations

### Unit Tests (with Mocks)

- **Purpose**: Test component logic and hook behavior in isolation
- **Approach**: Mock `expo-router` functions to focus on business logic
- **Coverage**: Component rendering, state management, user interactions

### Integration Tests (with renderRouter)

- **Purpose**: Test navigation flows and route behavior
- **Approach**: Import `renderRouter` from `expo-router/testing-library` (submodule, not separate package)
- **Coverage**: Navigation paths, parameter passing, screen transitions
- **Key Features**: Inline file system mocking, `initialUrl` support, custom Jest matchers

## Implementation Steps

### Phase 1: Jest Configuration Setup

1. Configure two Jest projects (unit and integration)
2. Create separate setup files for each test type
3. Update `transformIgnorePatterns` for PNPM compatibility
4. Remove any `moduleNameMapper` entries for expo-router

### Phase 2: Unit Test Setup

1. Create `__mocks__/expo-router.ts` with TypeScript-safe mocks
2. Update hook tests to use `.unit.(ts|tsx)` naming convention
3. Verify mocked router functions work in isolation

### Phase 3: Integration Test Implementation

```typescript
// __tests__/navigation.flow.int.tsx
import { renderRouter, screen } from 'expo-router/testing-library';

it('navigates to /add-expense from home', async () => {
  await renderRouter(
    {
      'app/_layout': () => null,
      'app/(tabs)/index': () => <Button title="Add" onPress={() => router.push('/add-expense')} />,
      'app/add-expense': () => <Text testID="page">Add Expense</Text>,
    },
    { initialUrl: '/' }
  );

  await screen.user.click(await screen.findByText('Add'));
  await screen.findByTestId('page');
  expect(screen).toHavePathname('/add-expense');
});
```

### Phase 4: Test File Migration

1. Rename existing test files to `.unit.(ts|tsx)` pattern
2. Move any tests from `app/` directory to `__tests__/`
3. Add integration tests for critical navigation flows

## Key Implementation Guidelines (Doc-Aligned)

### 1. Critical Don'ts

- ❌ **Don't install a separate package**: `expo-router/testing-library` is a submodule import, not a separate package
- ❌ **Don't put tests in app/**: Expo Router requires every file in `app/` to be a route or layout
- ❌ **Don't use moduleNameMapper for expo-router**: This prevents integration tests from using the real router

### 2. Required Approach

- ✅ **Use two Jest projects**: Separate unit (mocked) and integration (real router) test suites
- ✅ **Import directly**: `import { renderRouter } from 'expo-router/testing-library'`
- ✅ **Mock per-suite**: Use `jest.mock('expo-router')` in unit setup only

### 3. Testing Patterns

- **Unit Tests**: Mock router functions, test business logic in isolation
- **Integration Tests**: Use `renderRouter()` with inline FS and `initialUrl`, assert with custom matchers

## Quick Implementation Checklist

- [ ] Remove any `moduleNameMapper` entries for expo-router from Jest config
- [ ] Add two Jest projects (unit/integration) with separate setups
- [ ] Create `__mocks__/expo-router.ts` with TypeScript-safe mocks
- [ ] Add `jest.setup.unit.ts` with `jest.mock('expo-router')`
- [ ] Add `jest.setup.int.ts` without expo-router mocking
- [ ] Keep `jest-expo` preset and PNPM-safe `transformIgnorePatterns`
- [ ] Write 2-3 high-value `renderRouter` tests for critical flows
- [ ] Rename existing hook/component tests to `.unit.(ts|tsx)`
- [ ] Ensure no test files exist inside `app/` directory

## Example Test Files for Our Project

### Unit Test Example

```typescript
// __tests__/hooks/useExpenseForm.unit.tsx
import { renderHook } from '@testing-library/react-native';
import { useExpenseForm } from '../../src/hooks/useExpenseForm';

// router is mocked via jest.setup.unit.ts
jest.mock('expo-router');

it('calls router.back after successful submission', () => {
  const { result } = renderHook(() => useExpenseForm({ editingExpense: null }));

  result.current.handleSubmit();

  expect(router.back).toHaveBeenCalled();
});
```

### Integration Test Example

```typescript
// __tests__/flows/expense-creation.int.tsx
import { renderRouter, screen } from 'expo-router/testing-library';

it('navigates through expense creation flow', async () => {
  await renderRouter({
    'app/_layout': () => <Stack />,
    'app/(tabs)/index': () => <FloatingActionButton />,
    'app/add-expense': () => <Text testID="add-expense-screen">Add Expense</Text>,
  }, {
    initialUrl: '/'
  });

  await screen.user.press(await screen.findByRole('button'));
  await screen.findByTestId('add-expense-screen');
  expect(screen).toHavePathname('/add-expense');
});
```

## Why This Approach Works

This doc-aligned strategy ensures:

- **Proper separation**: Unit tests focus on logic, integration tests verify navigation flows
- **Real router testing**: Integration tests use actual Expo Router functionality
- **TypeScript safety**: Proper mock types prevent runtime errors
- **PNPM compatibility**: Transform patterns handle PNPM's `.pnpm/` directory structure
- **Maintainability**: Clear separation between test types reduces complexity

The two-project approach eliminates per-test boilerplate and prevents accidental global mocks from interfering with integration tests that need the real router.
