# Testing Infrastructure Improvement Plan

*Created: September 19, 2025*

## Executive Summary

The current testing implementation provides a foundation but needs significant expansion to meet the comprehensive testing strategy outlined in TESTING_STRATEGY.md. The current simplified structure covers only basic utility functions, while the FUNCTION_LOG.md identifies 94+ mobile features requiring testing.

## Current State Analysis

### ✅ What's Working
- **Jest + TypeScript setup** with working configuration
- **17 passing tests** for utility functions (insightCalculations)
- **CI/CD pipeline** configured with GitHub Actions
- **E2E framework** (Detox) configured and ready
- **Test fixtures** and basic mocking infrastructure

### ❌ Critical Gaps
1. **Coverage**: Only utilities tested, missing 90+ features
2. **Store Testing**: No tests for Zustand stores (core business logic)
3. **Component Testing**: No React Native component tests
4. **Integration Testing**: No screen/workflow tests
5. **E2E Implementation**: Framework ready but no actual tests
6. **Test Data**: Limited fixtures for complex scenarios

## Improvement Plan Overview

### Phase 1: Core Foundation (1-2 weeks)
- Implement comprehensive store testing
- Add React Native component test infrastructure
- Create robust test fixtures and mocking

### Phase 2: Feature Coverage (2-3 weeks)
- Test all 30+ core mobile features
- Implement integration tests for key workflows
- Build E2E tests for critical user journeys

### Phase 3: Quality & Optimization (1 week)
- Achieve 80%+ code coverage
- Performance and visual regression testing
- CI/CD optimization and reporting

---

# Phase 1: Core Foundation

## 1.1 Store Testing Infrastructure

**Priority**: Critical - Stores contain all business logic

### Current Gap
No tests for Zustand stores that manage:
- Expense CRUD operations
- Group management
- Category operations
- User settings
- Composed store subscriptions

### Implementation Plan

#### 1.1.1 Store Test Setup
```typescript
// src/__tests__/store-setup.ts
import { beforeEach } from '@jest/globals';
import { useExpenseStore } from '../store/expenseStore';
import { useUserStore } from '../store/userStore';
import { useCategoryStore } from '../store/categoryStore';

export const resetAllStores = () => {
  useExpenseStore.getState().clearAll();
  useUserStore.getState().clearUserData();
  useCategoryStore.getState().resetToDefaults();
};

export const setupStoreTests = () => {
  beforeEach(() => {
    resetAllStores();
  });
};
```

#### 1.1.2 Expense Store Test Suite
```typescript
// src/store/__tests__/expenseStore.test.ts
describe('ExpenseStore - Core Operations', () => {
  it('should add expense with auto-generated ID');
  it('should validate required fields');
  it('should handle negative amounts');
  it('should assign to groups correctly');
  it('should track expense modifications');
  it('should calculate category totals');
  it('should filter by date ranges');
  it('should handle concurrent operations');
});

describe('ExpenseStore - Group Features', () => {
  it('should calculate group balances');
  it('should split expenses equally');
  it('should handle participant removal');
  it('should track individual contributions');
});
```

#### 1.1.3 Composed Store Test Suite
```typescript
// src/store/__tests__/composedExpenseStore.test.ts
describe('ComposedExpenseStore - State Synchronization', () => {
  it('should sync user settings changes');
  it('should maintain reactivity across stores');
  it('should handle store subscription lifecycle');
  it('should prevent circular update loops');
});
```

**Effort**: 2-3 days
**Files to Create**: 8 test files covering all stores
**Expected Coverage**: 90% of store logic

## 1.2 React Native Component Testing

**Priority**: High - Components drive user interaction

### Current Gap
No component tests despite having:
- Complex forms (AddExpenseScreen, CategoryForm)
- Data visualization (CategoryChart, PieChart)
- Navigation components
- Custom UI components

### Implementation Plan

#### 1.2.1 Component Test Infrastructure
```typescript
// src/__tests__/component-setup.ts
import 'react-native';
import '@testing-library/jest-native/extend-expect';
import { render } from '@testing-library/react-native';
import { NavigationContainer } from '@react-navigation/native';

export const renderWithNavigation = (component: React.ReactElement) => {
  return render(
    <NavigationContainer>
      {component}
    </NavigationContainer>
  );
};

export const renderWithProviders = (component: React.ReactElement) => {
  // Add any global providers (themes, etc.)
  return renderWithNavigation(component);
};
```

#### 1.2.2 Priority Component Tests
1. **CategoryChart** (High complexity visualization)
   - Data rendering accuracy
   - Legend display logic
   - Empty state handling
   - Color coding correctness

2. **CategoryForm** (Form validation)
   - Input validation
   - Color picker interaction
   - Save/cancel behavior
   - Error state display

3. **AddExpenseScreen** (Critical user flow)
   - Form field validation
   - Category selection
   - Group assignment
   - Navigation on success

**Effort**: 3-4 days
**Files to Create**: 12-15 component test files
**Expected Coverage**: 80% of component logic

## 1.3 Enhanced Test Fixtures

**Priority**: Medium - Enables realistic testing

### Current Gap
Limited test data covering only basic expense scenarios

### Implementation Plan

#### 1.3.1 Comprehensive Fixture Library
```typescript
// src/__tests__/fixtures/enhanced-fixtures.ts
export const testFixtures = {
  users: {
    singleUser: { id: 'user-1', username: 'testuser', internalId: 'int-1' },
    couple: [
      { id: 'user-1', username: 'alice', internalId: 'int-1' },
      { id: 'user-2', username: 'bob', internalId: 'int-2' }
    ]
  },

  categories: {
    full: [
      { id: 'cat-1', name: 'Food & Dining', color: '#FF5722' },
      { id: 'cat-2', name: 'Transportation', color: '#2196F3' },
      { id: 'cat-3', name: 'Entertainment', color: '#9C27B0' }
    ]
  },

  expenses: {
    individual: [
      { title: 'Coffee', amount: 4.50, category: 'cat-1', date: '2025-09-19' },
      { title: 'Lunch', amount: 12.75, date: '2025-09-18' }
    ],

    group: [
      {
        title: 'Group Dinner',
        amount: 80.00,
        groupId: 'group-1',
        paidBy: 'user-1',
        participants: ['user-1', 'user-2']
      }
    ],

    monthlyData: generateMonthlyExpenses(6), // 6 months of test data
    yearlyData: generateYearlyExpenses(2)    // 2 years of test data
  },

  groups: {
    simple: { id: 'group-1', name: 'Test Group', participants: ['user-1', 'user-2'] },
    complex: generateComplexGroup(5) // Group with 5 participants and mixed expenses
  }
};
```

**Effort**: 1-2 days
**Files to Create**: 3-4 fixture files
**Expected Coverage**: All test scenarios covered

---

# Phase 2: Feature Coverage

## 2.1 Integration Testing

**Priority**: Critical - Validates feature workflows

### Current Gap
No integration tests for critical user flows identified in FUNCTION_LOG.md

### Implementation Plan

#### 2.1.1 Screen Integration Tests
```typescript
// src/screens/__tests__/AddExpenseScreen.integration.test.tsx
describe('AddExpenseScreen Integration', () => {
  it('should complete full expense creation flow');
  it('should handle group expense assignment');
  it('should validate form and show errors');
  it('should navigate back on successful save');
  it('should integrate with store correctly');
});
```

#### 2.1.2 Critical Workflow Tests
1. **New User Onboarding** (E2E critical path)
   - Settings → Username setup → Group creation

2. **Expense Management** (Core functionality)
   - Add → Edit → Delete expense workflow

3. **Group Features** (Complex business logic)
   - Create group → Add participants → Split expenses

4. **Insights** (Data accuracy)
   - Navigate periods → Verify calculations → Export data

**Effort**: 4-5 days
**Files to Create**: 8-10 integration test files
**Expected Coverage**: All critical user flows

## 2.2 E2E Test Implementation

**Priority**: High - Real device validation

### Current Gap
Detox configured but no actual E2E tests written

### Implementation Plan

#### 2.2.1 E2E Test Suite Structure
```
e2e/
├── setup.js              ✅ Already exists
├── userOnboarding.e2e.js  ⭐ Critical path
├── expenseManagement.e2e.js ⭐ Core features
├── groupWorkflow.e2e.js   ⭐ Complex interactions
├── categoryManagement.e2e.js
├── insightsNavigation.e2e.js
└── dataValidation.e2e.js
```

#### 2.2.2 Priority E2E Tests
1. **User Onboarding Journey** (Most critical)
   ```javascript
   describe('New User Onboarding', () => {
     it('should complete first-time user setup');
     it('should require username for group creation');
     it('should guide through first expense creation');
   });
   ```

2. **Cross-Screen Data Flow** (Data integrity)
   ```javascript
   describe('Data Consistency', () => {
     it('should persist expense across app restart');
     it('should sync category changes across screens');
     it('should maintain group state during navigation');
   });
   ```

**Effort**: 5-6 days
**Files to Create**: 6-7 E2E test files
**Expected Coverage**: All critical user journeys

## 2.3 Component Test Expansion

**Priority**: Medium - Complete component coverage

### Implementation Plan

#### 2.3.1 Remaining Component Tests
Based on FUNCTION_LOG.md feature analysis:

1. **Home Screen Components**
   - Expense list rendering
   - FAB button behavior
   - Total calculations display

2. **History Screen Components**
   - Group list display
   - Balance calculations
   - Navigation to group details

3. **Settings Screen Components**
   - Username form validation
   - Settings persistence
   - Navigation links

**Effort**: 3-4 days
**Files to Create**: 10-12 additional component tests
**Expected Coverage**: 85% of component code

---

# Phase 3: Quality & Optimization

## 3.1 Coverage Achievement

**Priority**: High - Meet quality standards

### Target Coverage Metrics
- **Store Logic**: 90%+ (business critical)
- **Components**: 80%+ (user interaction)
- **Utilities**: 95%+ (pure functions)
- **Overall**: 85%+ (project standard)

### Implementation Plan

#### 3.1.1 Coverage Analysis & Gap Filling
```bash
# Generate detailed coverage report
npm run test:coverage -- --coverage-reporters=html-spa

# Identify uncovered code paths
npm run test:coverage -- --coverage-reporters=text-summary --verbose
```

#### 3.1.2 Coverage Enforcement
```javascript
// jest.config.js updates
coverageThreshold: {
  global: {
    branches: 80,    // Up from 70
    functions: 85,   // Up from 70
    lines: 85,       // Up from 70
    statements: 85   // Up from 70
  },
  // Per-file thresholds for critical files
  './src/store/': {
    branches: 90,
    functions: 95,
    lines: 95,
    statements: 95
  }
}
```

**Effort**: 2-3 days
**Expected Outcome**: Consistent 85%+ coverage

## 3.2 Performance Testing

**Priority**: Medium - Validate app performance

### Implementation Plan

#### 3.2.1 Performance Test Suite
```typescript
// src/__tests__/performance/store-performance.test.ts
describe('Store Performance', () => {
  it('should handle 1000 expenses without lag');
  it('should complete calculations under 100ms');
  it('should maintain memory usage under threshold');
});
```

#### 3.2.2 Bundle Size Monitoring
```javascript
// webpack.config.js additions for bundle analysis
module.exports = {
  plugins: [
    new BundleAnalyzerPlugin({
      analyzerMode: 'static',
      generateStatsFile: true
    })
  ]
};
```

**Effort**: 2 days
**Expected Outcome**: Performance benchmarks established

## 3.3 CI/CD Optimization

**Priority**: Medium - Improve development workflow

### Implementation Plan

#### 3.3.1 Enhanced GitHub Actions
```yaml
# .github/workflows/test-mobile-enhanced.yml
jobs:
  test-matrix:
    strategy:
      matrix:
        test-type: [unit, integration, e2e]
        os: [ubuntu-latest, macos-latest]

  coverage-report:
    needs: test-matrix
    runs-on: ubuntu-latest
    steps:
      - name: Combine coverage reports
      - name: Upload to Codecov
      - name: PR comment with results
```

#### 3.3.2 Pre-commit Quality Gates
```bash
# .husky/pre-commit
#!/bin/sh
npm run test:unit:fast
npm run lint:fix
npm run typecheck
```

**Effort**: 1-2 days
**Expected Outcome**: Faster feedback cycles

---

# Implementation Timeline

## Week 1: Foundation
- **Days 1-2**: Store testing infrastructure and core tests
- **Days 3-4**: Component testing setup and priority components
- **Day 5**: Enhanced fixtures and test data

## Week 2: Feature Coverage
- **Days 1-2**: Integration tests for core workflows
- **Days 3-4**: E2E test implementation (critical paths)
- **Day 5**: Remaining component tests

## Week 3: Quality & Polish
- **Days 1-2**: Coverage analysis and gap filling
- **Days 3-4**: Performance testing and optimization
- **Day 5**: CI/CD enhancements and documentation

## Week 4: Validation & Documentation
- **Days 1-2**: Full test suite validation
- **Days 3-4**: Test documentation and team training
- **Day 5**: Metrics collection and reporting

---

# Success Metrics

## Quantitative Goals
- **Test Count**: 150+ tests (up from 17)
- **Coverage**: 85%+ overall, 90%+ for stores
- **E2E Tests**: 8+ critical user journeys
- **CI/CD Speed**: <10 minutes for full test suite

## Qualitative Goals
- **Developer Confidence**: High confidence in refactoring
- **Bug Prevention**: Catch regressions before deployment
- **Documentation**: Comprehensive test patterns for team
- **Maintainability**: Easy to add tests for new features

---

# Risk Mitigation

## Technical Risks
1. **React Native Testing Complexity**: Start with simpler components
2. **E2E Test Flakiness**: Implement robust wait strategies
3. **CI/CD Resource Usage**: Optimize test parallelization
4. **Coverage Enforcement**: Gradual threshold increases

## Timeline Risks
1. **Scope Creep**: Focus on critical paths first
2. **Learning Curve**: Pair programming for knowledge transfer
3. **Existing Code Changes**: Freeze feature development during testing

---

# Manual Testing Commands

## Current Available Commands

Navigate to the mobile app directory first:
```bash
cd apps/mobile
```

### Unit Tests
```bash
# Run all tests once
npm run test

# Run tests in watch mode (re-runs on file changes)
npm run test:watch

# Run tests with coverage report
npm run test:coverage

# Run tests with coverage and enforce thresholds
npm run test:coverage-check
```

### E2E Tests (Detox)
```bash
# Build the app for testing
npm run test:e2e:build

# Run E2E tests (requires iOS simulator)
npm run test:e2e
```

### Comprehensive Test Scripts
```bash
# Run all tests (unit + lint + typecheck)
npm run test:all

# Run all tests including E2E
npm run test:all:e2e
```

### Individual Commands
```bash
# TypeScript checking
npm run typecheck

# ESLint code quality
npm run lint
```

## Current Working Tests

The following command runs 17 passing tests:
```bash
cd apps/mobile && npm run test
```

**Output shows**:
- ✓ Insight Calculations (17 tests)
- Coverage: Utility functions (calculateCategoryTotals, filterExpensesByDate, etc.)
- Test file: `src/utils/__tests__/simple.test.ts`

## Future Commands (After Improvement Plan)

Once the improvement plan is implemented, these additional commands will be available:

### Store Tests
```bash
# Test only store logic
npm run test -- src/store

# Test specific store
npm run test -- src/store/__tests__/expenseStore.test.ts
```

### Component Tests
```bash
# Test only components
npm run test -- src/components

# Test specific component
npm run test -- src/components/__tests__/CategoryChart.test.tsx
```

### Integration Tests
```bash
# Test only screen integrations
npm run test -- src/screens

# Test specific screen
npm run test -- src/screens/__tests__/AddExpenseScreen.test.tsx
```

### Performance Tests
```bash
# Run performance benchmarks
npm run test:performance

# Run with memory profiling
npm run test:performance -- --logHeapUsage
```

---

# Conclusion

This improvement plan transforms the current minimal testing setup into a comprehensive, production-ready testing infrastructure. The phased approach ensures steady progress while maintaining development velocity.

**Next Steps**:
1. Review and approve this plan
2. Begin Phase 1 implementation
3. Establish daily progress check-ins
4. Update FUNCTION_LOG.md as features gain test coverage

The investment in comprehensive testing will pay dividends in code quality, developer productivity, and confidence in the mobile application as it prepares for API integration in Phase 2.