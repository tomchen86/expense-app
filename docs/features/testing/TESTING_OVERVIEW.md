# Testing Overview - Single Source of Truth

_Last updated: September 30, 2025_

## Purpose

This document serves as the central reference for all testing in the project. It provides an overview of test strategy, current coverage, and links to detailed documentation for each testing layer.

---

## Quick Summary

| Layer                  | Framework     | Test Count | Status            | Coverage                      |
| ---------------------- | ------------- | ---------- | ----------------- | ----------------------------- |
| **Mobile Unit**        | Jest + RTL    | 200+       | ✅ Passing        | `MOBILE_UNIT_TESTS.md`        |
| **Mobile Integration** | Jest + RTL    | 90+        | ✅ Passing        | `MOBILE_INTEGRATION_TESTS.md` |
| **Mobile E2E**         | Detox         | 62         | 🚧 Setup Complete | `E2E_TESTID_MAPPING.md`       |
| **API**                | Jest → Vitest | 142        | ✅ Passing        | `API_TEST_SUMMARY.md`         |
| **Web**                | Jest → Vitest | Basic      | 🚧 Minimal        | —                             |
| **Total**              | —             | **436+**   | ✅                | —                             |

---

## Test Strategy by Layer

### Mobile App (React Native + Expo)

**Framework**: Jest + React Native Testing Library
**Test Types**: Unit, Integration, E2E
**Total Coverage**: 294/294 tests passing (100%)

#### Unit Tests

- **Count**: 200+ tests
- **Naming**: `*.unit.ts(x)`
- **Focus**: Component logic, hooks, utilities in isolation
- **Mocking**: Expo Router mocked via `jest.setup.unit.ts`
- **Documentation**: [`MOBILE_UNIT_TESTS.md`](./MOBILE_UNIT_TESTS.md)

**Key Areas**:

- Components: 100+ tests
- Hooks: 50+ tests
- Store (Zustand): 30+ tests
- Utilities: 20+ tests

#### Integration Tests

- **Count**: 90+ tests
- **Naming**: `*.int.ts(x)`
- **Focus**: Component + store interactions, cross-module behavior
- **Mocking**: Minimal (real store, mocked router)
- **Documentation**: [`MOBILE_INTEGRATION_TESTS.md`](./MOBILE_INTEGRATION_TESTS.md)

**Key Areas**:

- Screen flows: 40+ tests
- Form interactions: 30+ tests
- Store integration: 20+ tests

#### E2E Tests

- **Count**: 62 tests (3 suites)
- **Framework**: Detox v20.42.0
- **Status**: 🚧 Infrastructure complete, build pending
- **Naming**: `*.e2e.js`
- **Documentation**: [`MOBILE_E2E_TESTS.md`](./MOBILE_E2E_TESTS.md)

**Test Suites**:

- `userOnboarding.e2e.js`: 17 tests
- `dataValidation.e2e.js`: 25 tests
- `expenseFlow.test.js`: 20 tests

**Infrastructure Status**:

- ✅ Ejected to bare workflow
- ✅ Detox configuration updated
- ✅ Phase 1 testIDs added (8/23)
- 🚧 iOS build pending
- 🚧 Phase 2-3 testIDs (15 remaining)

---

### API (NestJS)

**Framework**: Jest (migrating to Vitest - ISS-208)
**Test Count**: 142/142 passing (100%)
**Documentation**: [`API_TEST_SUMMARY.md`](./API_TEST_SUMMARY.md)

#### Test Breakdown

- **Unit Tests**: Entity tests, service logic
- **Integration Tests**: API endpoint tests with test database
- **Coverage**: All controllers, services, entities

**Key Areas**:

- Authentication: 20+ tests
- User Management: 15+ tests
- Categories: 10+ tests
- Expenses: 30+ tests
- Groups & Participants: 20+ tests
- Database migrations: 10+ tests

**Migration Plan** (ISS-208):

- Native ESM support
- Faster test execution (~10x)
- Better TypeScript integration
- Target: Complete by end of Phase 2

---

### Web (Next.js)

**Framework**: Jest (migrating to Vitest - ISS-209)
**Status**: Basic setup, deferred until API completion
**Priority**: Later

---

## Test Infrastructure

### Jest Configuration (Mobile)

**Dual-project setup** for unit vs integration tests:

```javascript
// jest.config.js
module.exports = {
  preset: 'jest-expo',
  projects: [
    {
      displayName: 'unit',
      testMatch: ['**/__tests__/**/*.unit.(ts|tsx)'],
      setupFilesAfterEnv: ['<rootDir>/jest.setup.unit.ts'],
    },
    {
      displayName: 'integration',
      testMatch: ['**/__tests__/**/*.int.(ts|tsx)'],
      setupFilesAfterEnv: ['<rootDir>/jest.setup.int.ts'],
    },
  ],
};
```

**Key Points**:

- Unit tests: Mock expo-router
- Integration tests: Use real router when possible
- Detox: Separate configuration (.detoxrc.js)

### Expo Router Testing Strategy

We use a **hybrid approach** depending on what's being tested:

#### When to Mock Router (Current Approach)

✅ **Use mocks for**:

- Hook tests focusing on business logic
- Component tests where navigation is incidental
- Tests where router usage is minimal (`router.back()` only)

**Example**: `useExpenseForm-category-sync.int.tsx`

- Type: Hook behavior integration test
- Focus: Category store synchronization
- Router usage: Just `router.back()` call
- **Verdict**: Mock is appropriate ✅

**Setup**:

```typescript
jest.mock('expo-router', () => ({
  router: {
    back: jest.fn(),
    push: jest.fn(),
  },
}));
```

#### When to Use renderRouter (Planned - ISS-106)

✅ **Use `renderRouter` for**:

1. **Navigation flow tests** - Testing actual route transitions
2. **Screen component tests** - Components that render based on routes
3. **Parameter passing tests** - Data flow between screens

**Tests that SHOULD use `renderRouter`** (not yet created):

- Navigation from Home → Add Expense → Back
- Editing expense with route params
- Group detail navigation
- Tab navigation between screens

**Example** (planned):

```typescript
import { renderRouter, screen } from 'expo-router/testing-library';

it('navigates to /add-expense from home', async () => {
  await renderRouter({
    'app/(tabs)/index': () => <HomeScreen />,
    'app/add-expense': () => <AddExpenseScreen />,
  }, { initialUrl: '/' });

  await screen.user.click(await screen.findByTestId('add-expense-fab'));
  expect(screen).toHavePathname('/add-expense');
});
```

**Reference**: [`EXPO_ROUTER_TESTING_ANALYSIS.md`](./EXPO_ROUTER_TESTING_ANALYSIS.md)

---

## Coverage by Feature Domain

### Expense Management

- **Unit**: 80+ tests
- **Integration**: 40+ tests
- **E2E**: 20+ tests
- **Status**: ✅ Full coverage

### Category Management

- **Unit**: 20+ tests
- **Integration**: 15+ tests (including new sync test)
- **Status**: ✅ Full coverage

### Group & Participant Management

- **Unit**: 30+ tests
- **Integration**: 15+ tests
- **E2E**: 10+ tests
- **Status**: ✅ Full coverage

### User Settings & Onboarding

- **Unit**: 15+ tests
- **Integration**: 10+ tests
- **E2E**: 17+ tests
- **Status**: ✅ Full coverage

### Insights & Analytics

- **Unit**: 25+ tests
- **Integration**: 10+ tests
- **Status**: ✅ Full coverage

---

## Testing Best Practices

### Test Naming Conventions

- **Unit**: `ComponentName.unit.tsx` or `hookName.unit.tsx`
- **Integration**: `FeatureName.integration.int.tsx`
- **E2E**: `flowName.e2e.js`

### Test Organization

```
src/
├── components/
│   ├── ComponentName.tsx
│   └── __tests__/
│       ├── ComponentName-logic.unit.tsx
│       └── ComponentName-rendering.unit.tsx
├── hooks/
│   ├── useHookName.tsx
│   └── __tests__/
│       ├── useHookName.unit.tsx
│       └── useHookName-integration.int.tsx
└── screens/
    ├── ScreenName.tsx
    └── __tests__/
        ├── ScreenName-logic.unit.tsx
        └── ScreenName.integration.int.tsx
```

### When to Write Each Test Type

**Unit Test**:

- Pure functions and utilities
- Component rendering logic
- Hook state management
- Store actions in isolation

**Integration Test**:

- Screen + store interactions
- Form submission flows
- Cross-component behavior
- Hook + store synchronization

**E2E Test**:

- User journeys (onboarding, expense creation)
- Navigation flows
- Data persistence across screens
- Critical business paths

---

## Running Tests

### Mobile

```bash
# Run all tests
pnpm --filter mobile test

# Run unit tests only
pnpm --filter mobile test:unit

# Run integration tests only
pnpm --filter mobile test:int

# Run E2E tests (after build)
pnpm --filter mobile test:e2e

# Watch mode
pnpm --filter mobile test -- --watch

# Coverage
pnpm --filter mobile test -- --coverage
```

### API

```bash
# Run all tests
pnpm --filter api test

# Run with coverage
pnpm --filter api test:cov

# Run E2E tests
pnpm --filter api test:e2e

# Run specific test file
pnpm --filter api test -- path/to/test.spec.ts
```

### Monorepo-wide

```bash
# Run all tests across workspace
pnpm test --recursive

# Lint all packages
pnpm lint --recursive
```

---

## Current Issues & Improvements

See [`ISSUE_LOG.md`](../../ISSUE_LOG.md) for active testing issues:

- **ISS-106**: Navigation integration tests with `renderRouter`
- **ISS-207**: This document (testing overview)
- **ISS-208**: Migrate API tests to Vitest
- **ISS-209**: Migrate Web tests to Vitest

---

## Additional Documentation

### Detailed Test Documentation

- [Mobile Unit Tests](./MOBILE_UNIT_TESTS.md) - Component, hook, store tests
- [Mobile Integration Tests](./MOBILE_INTEGRATION_TESTS.md) - Cross-module integration
- [Mobile E2E Tests](./MOBILE_E2E_TESTS.md) - Detox E2E tests and testID mapping
- [API Test Summary](./API_TEST_SUMMARY.md) - NestJS API tests

### Testing Strategy & Analysis

- [Testing Strategy](./TESTING_STRATEGY.md) - Overall approach and methodology
- [Expo Router Testing Analysis](./EXPO_ROUTER_TESTING_ANALYSIS.md) - Router testing patterns
- [Testing Improvement Plan](./TESTING_IMPROVEMENT_PLAN.md) - Future enhancements

### Historical Reference

- [Identity Phase Checklist](./IDENTITY_PHASE_CHECKLIST.md) - Database identity phase
- [Identity Phase Status](./IDENTITY_PHASE_STATUS.md) - Completion status
- [Phase 3 Testing Report](./PHASE3_TESTING_REPORT.md) - Historical phase report

---

## Maintenance

**Update this document when**:

- Test counts change significantly (>10%)
- New test types are added
- Testing infrastructure changes
- Framework migrations occur

**Review cadence**: Monthly or after major feature completion

---

_For questions about testing strategy or infrastructure, refer to this document first, then consult the linked detailed documentation._
