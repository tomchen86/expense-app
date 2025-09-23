# Testing Strategy

*Last Updated: September 19, 2025*

## Overview
Comprehensive testing strategy for the expense tracking monorepo covering Mobile (React Native), API (NestJS), and Web (Next.js) applications.

## Testing Philosophy
- **Test Pyramid**: More unit tests, fewer E2E tests
- **Test-Driven Development**: Write tests before or alongside implementation
- **Continuous Testing**: Automated testing in CI/CD pipeline
- **Quality Gates**: All tests must pass before deployment

---

# Mobile App Testing (apps/mobile/)

## Test Framework Setup

### Unit & Integration Testing
```bash
# Dependencies
pnpm add -D jest @testing-library/react-native @testing-library/jest-native

# Configuration: jest.config.js
module.exports = {
  preset: 'react-native',
  setupFilesAfterEnv: ['<rootDir>/src/__tests__/setup.ts'],
  testMatch: [
    '<rootDir>/src/**/__tests__/**/*.test.{js,ts,tsx}',
    '<rootDir>/src/**/*.test.{js,ts,tsx}'
  ],
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.d.ts',
    '!src/**/__tests__/**',
    '!src/types/**'
  ],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80
    }
  }
};
```

### End-to-End Testing
```bash
# Detox setup for E2E
pnpm add -D detox @config/detox

# .detoxrc.js
module.exports = {
  testRunner: 'jest',
  runnerConfig: 'e2e/config.json',
  apps: {
    'ios.debug': {
      type: 'ios.app',
      binaryPath: 'ios/build/Build/Products/Debug-iphonesimulator/ExpenseTracker.app',
      build: 'xcodebuild -workspace ios/ExpenseTracker.xcworkspace -scheme ExpenseTracker -configuration Debug -sdk iphonesimulator -derivedDataPath ios/build'
    }
  },
  devices: {
    simulator: {
      type: 'ios.simulator',
      device: { type: 'iPhone 15' }
    }
  }
};
```

## Test Structure & Organization

### Directory Structure
```
apps/mobile/src/
├── __tests__/
│   ├── setup.ts                    # Test configuration
│   ├── mocks/                      # Mock modules
│   └── fixtures/                   # Test data
├── components/
│   ├── __tests__/                  # Component unit tests
│   └── ui/
│       ├── Button.test.tsx
│       └── CategoryChart.test.tsx
├── store/
│   ├── __tests__/                  # Store logic tests
│   ├── expenseStore.test.ts
│   └── composedStore.test.ts
├── utils/
│   ├── __tests__/                  # Utility function tests
│   ├── calculations.test.ts
│   └── formatters.test.ts
└── screens/
    ├── __tests__/                  # Screen integration tests
    ├── AddExpenseScreen.test.tsx
    └── ExpenseInsightsScreen.test.tsx

e2e/
├── firstTest.e2e.js               # Critical user journeys
├── expenseFlow.e2e.js             # Expense management flow
└── groupFlow.e2e.js               # Group creation and management
```

## Critical Test Scenarios

### Unit Tests (80% of test effort)

#### Store Logic Tests
```typescript
// store/__tests__/expenseStore.test.ts
describe('ExpenseStore', () => {
  beforeEach(() => {
    // Reset store state
    useExpenseStore.getState().clearAll();
  });

  describe('addExpense', () => {
    it('should add expense with valid data', () => {
      const expense = {
        title: 'Lunch',
        amount: 12.50,
        category: { id: '1', name: 'Food', color: '#FF5722' },
        date: '2025-09-19'
      };

      useExpenseStore.getState().addExpense(expense);
      const expenses = useExpenseStore.getState().expenses;

      expect(expenses).toHaveLength(1);
      expect(expenses[0]).toMatchObject(expense);
      expect(expenses[0].id).toBeDefined();
    });

    it('should validate amount is positive', () => {
      const expense = { title: 'Test', amount: -10, category: mockCategory };

      expect(() => {
        useExpenseStore.getState().addExpense(expense);
      }).toThrow('Amount must be positive');
    });

    it('should assign to group when groupId provided', () => {
      const groupId = 'group-1';
      const expense = { title: 'Group Lunch', amount: 50, groupId };

      useExpenseStore.getState().addExpense(expense);
      const addedExpense = useExpenseStore.getState().expenses[0];

      expect(addedExpense.groupId).toBe(groupId);
    });
  });

  describe('group calculations', () => {
    it('should calculate group totals correctly', () => {
      // Add multiple expenses to a group
      const groupId = 'group-1';
      const expenses = [
        { title: 'Expense 1', amount: 20, groupId },
        { title: 'Expense 2', amount: 30, groupId },
        { title: 'Other', amount: 15, groupId: 'group-2' }
      ];

      expenses.forEach(exp => useExpenseStore.getState().addExpense(exp));

      const groupTotal = useExpenseStore.getState().getGroupTotal(groupId);
      expect(groupTotal).toBe(50);
    });

    it('should calculate user balance in group', () => {
      // Test split calculations and user balances
      const groupId = 'group-1';
      const userId1 = 'user-1';
      const userId2 = 'user-2';

      // User 1 pays $60, split equally
      const expense = {
        title: 'Dinner',
        amount: 60,
        groupId,
        paidBy: userId1,
        splitBetween: [userId1, userId2]
      };

      useExpenseStore.getState().addExpense(expense);

      const balance = useExpenseStore.getState().getUserBalanceInGroup(groupId, userId1);
      expect(balance).toBe(30); // Paid $60, owes $30
    });
  });
});
```

#### Component Tests
```typescript
// components/__tests__/CategoryChart.test.tsx
import { render, screen } from '@testing-library/react-native';
import CategoryChart from '../insights/CategoryChart';

describe('CategoryChart', () => {
  const mockData = [
    { category: { name: 'Food', color: '#FF5722' }, amount: 100, percentage: 60 },
    { category: { name: 'Transport', color: '#2196F3' }, amount: 66.67, percentage: 40 }
  ];

  it('should render pie chart with correct data', () => {
    render(<CategoryChart data={mockData} showLegend={true} />);

    expect(screen.getByText('Food')).toBeTruthy();
    expect(screen.getByText('$100.00')).toBeTruthy();
    expect(screen.getByText('60.0%')).toBeTruthy();
  });

  it('should hide legend when showLegend is false', () => {
    render(<CategoryChart data={mockData} showLegend={false} />);

    expect(screen.queryByText('Food')).toBeNull();
    // Chart should still render
    expect(screen.getByTestId('pie-chart')).toBeTruthy();
  });

  it('should handle empty data gracefully', () => {
    render(<CategoryChart data={[]} showLegend={true} />);

    expect(screen.getByText('No data available')).toBeTruthy();
  });
});
```

#### Utility Function Tests
```typescript
// utils/__tests__/insightCalculations.test.ts
import { calculateCategoryBreakdown, calculateMonthlyTrends } from '../insightCalculations';

describe('insightCalculations', () => {
  const mockExpenses = [
    { id: '1', amount: 50, category: { name: 'Food' }, date: '2025-09-15' },
    { id: '2', amount: 30, category: { name: 'Food' }, date: '2025-09-16' },
    { id: '3', amount: 20, category: { name: 'Transport' }, date: '2025-09-17' }
  ];

  describe('calculateCategoryBreakdown', () => {
    it('should calculate correct percentages', () => {
      const breakdown = calculateCategoryBreakdown(mockExpenses);

      expect(breakdown).toEqual([
        { category: { name: 'Food' }, total: 80, percentage: 80 },
        { category: { name: 'Transport' }, total: 20, percentage: 20 }
      ]);
    });

    it('should handle single expense', () => {
      const singleExpense = [mockExpenses[0]];
      const breakdown = calculateCategoryBreakdown(singleExpense);

      expect(breakdown).toEqual([
        { category: { name: 'Food' }, total: 50, percentage: 100 }
      ]);
    });

    it('should return empty array for no expenses', () => {
      const breakdown = calculateCategoryBreakdown([]);
      expect(breakdown).toEqual([]);
    });
  });

  describe('calculateMonthlyTrends', () => {
    it('should group expenses by month', () => {
      const expenses = [
        { amount: 100, date: '2025-08-15' },
        { amount: 150, date: '2025-08-20' },
        { amount: 200, date: '2025-09-10' }
      ];

      const trends = calculateMonthlyTrends(expenses, 3);

      expect(trends).toEqual([
        { month: '2025-08', total: 250, count: 2 },
        { month: '2025-09', total: 200, count: 1 }
      ]);
    });
  });
});
```

### Integration Tests (15% of test effort)

#### Screen Integration Tests
```typescript
// screens/__tests__/AddExpenseScreen.test.tsx
import { render, fireEvent, waitFor, screen } from '@testing-library/react-native';
import { NavigationContainer } from '@react-navigation/native';
import AddExpenseScreen from '../AddExpenseScreen';
import { useExpenseStore } from '../../store/expenseStore';

// Mock navigation
const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useNavigation: () => ({ navigate: mockNavigate })
}));

describe('AddExpenseScreen Integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useExpenseStore.getState().clearAll();
  });

  it('should complete full expense creation flow', async () => {
    render(
      <NavigationContainer>
        <AddExpenseScreen />
      </NavigationContainer>
    );

    // Fill out expense form
    fireEvent.changeText(screen.getByTestId('expense-title-input'), 'Test Expense');
    fireEvent.changeText(screen.getByTestId('expense-amount-input'), '25.50');

    // Select category
    fireEvent.press(screen.getByTestId('category-picker'));
    fireEvent.press(screen.getByText('Food & Dining'));

    // Submit form
    fireEvent.press(screen.getByTestId('save-expense-button'));

    await waitFor(() => {
      const expenses = useExpenseStore.getState().expenses;
      expect(expenses).toHaveLength(1);
      expect(expenses[0].title).toBe('Test Expense');
      expect(expenses[0].amount).toBe(25.50);
    });

    expect(mockNavigate).toHaveBeenCalledWith('Home');
  });

  it('should show validation errors for invalid input', async () => {
    render(<AddExpenseScreen />);

    // Try to submit empty form
    fireEvent.press(screen.getByTestId('save-expense-button'));

    await waitFor(() => {
      expect(screen.getByText('Title is required')).toBeTruthy();
      expect(screen.getByText('Amount must be greater than 0')).toBeTruthy();
    });
  });

  it('should handle group expense creation', async () => {
    // Pre-create a group
    const group = { id: 'group-1', name: 'Test Group', participants: [] };
    useExpenseStore.getState().addGroup(group);

    render(<AddExpenseScreen route={{ params: { groupId: 'group-1' } }} />);

    fireEvent.changeText(screen.getByTestId('expense-title-input'), 'Group Expense');
    fireEvent.changeText(screen.getByTestId('expense-amount-input'), '100');
    fireEvent.press(screen.getByTestId('save-expense-button'));

    await waitFor(() => {
      const expenses = useExpenseStore.getState().expenses;
      expect(expenses[0].groupId).toBe('group-1');
    });
  });
});
```

### End-to-End Tests (5% of test effort)

#### Critical User Journeys
```javascript
// e2e/expenseFlow.e2e.js
describe('Expense Management Flow', () => {
  beforeAll(async () => {
    await device.launchApp();
  });

  beforeEach(async () => {
    await device.reloadReactNative();
  });

  it('should complete new user expense journey', async () => {
    // Step 1: Set up username (required for groups)
    await element(by.text('Settings')).tap();
    await element(by.id('username-input')).typeText('TestUser');
    await element(by.text('Save')).tap();
    await expect(element(by.text('Username saved successfully'))).toBeVisible();

    // Step 2: Navigate to Home
    await element(by.text('Home')).tap();

    // Step 3: Add first expense
    await element(by.id('add-expense-fab')).tap();
    await element(by.id('expense-title-input')).typeText('Coffee');
    await element(by.id('expense-amount-input')).typeText('4.50');

    // Step 4: Select category
    await element(by.id('category-picker')).tap();
    await element(by.text('Food & Dining')).tap();

    // Step 5: Save expense
    await element(by.id('save-expense-button')).tap();

    // Step 6: Verify expense appears in list
    await expect(element(by.text('Coffee'))).toBeVisible();
    await expect(element(by.text('$4.50'))).toBeVisible();
  });

  it('should create and manage group expense', async () => {
    // Prerequisite: Username already set
    await element(by.text('Settings')).tap();
    await element(by.id('username-input')).replaceText('GroupUser');
    await element(by.text('Save')).tap();

    // Navigate to Groups
    await element(by.text('History')).tap();

    // Create new group
    await element(by.id('add-group-button')).tap();
    await element(by.id('group-name-input')).typeText('Dinner Group');
    await element(by.text('Create')).tap();

    // Add expense to group
    await element(by.text('Dinner Group')).tap();
    await element(by.id('add-expense-fab')).tap();
    await element(by.id('expense-title-input')).typeText('Restaurant Bill');
    await element(by.id('expense-amount-input')).typeText('80.00');
    await element(by.id('save-expense-button')).tap();

    // Verify group expense
    await expect(element(by.text('Restaurant Bill'))).toBeVisible();
    await expect(element(by.text('$80.00'))).toBeVisible();
  });

  it('should navigate insights and view analytics', async () => {
    // Add test data (multiple expenses)
    await element(by.text('Home')).tap();

    const expenses = [
      { title: 'Groceries', amount: '150.00', category: 'Food & Dining' },
      { title: 'Gas', amount: '45.00', category: 'Transportation' },
      { title: 'Movie', amount: '25.00', category: 'Entertainment' }
    ];

    for (const expense of expenses) {
      await element(by.id('add-expense-fab')).tap();
      await element(by.id('expense-title-input')).typeText(expense.title);
      await element(by.id('expense-amount-input')).typeText(expense.amount);
      await element(by.id('category-picker')).tap();
      await element(by.text(expense.category)).tap();
      await element(by.id('save-expense-button')).tap();
    }

    // Navigate to insights
    await element(by.id('total-share-button')).tap();

    // Verify insights screen
    await expect(element(by.id('pie-chart'))).toBeVisible();
    await expect(element(by.text('Food & Dining'))).toBeVisible();
    await expect(element(by.text('$150.00'))).toBeVisible();

    // Test time period navigation
    await element(by.id('previous-month-button')).tap();
    await element(by.id('next-month-button')).tap();

    // Test date picker
    await element(by.id('date-period-selector')).tap();
    await element(by.text('This Year')).tap();
  });
});
```

## Test Automation & CI/CD

### Pre-commit Hooks
```bash
# .husky/pre-commit
#!/bin/sh
pnpm --filter mobile run test:unit:fast
pnpm --filter mobile run lint
pnpm --filter mobile run typecheck
```

### GitHub Actions Workflow
```yaml
# .github/workflows/mobile-tests.yml
name: Mobile App Tests

on:
  pull_request:
    paths:
      - 'apps/mobile/**'
  push:
    branches: [main]

jobs:
  unit-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
          cache: 'pnpm'

      - name: Install dependencies
        run: |
          pnpm install --filter mobile --frozen-lockfile

      - name: Run unit tests
        run: |
          pnpm --filter mobile run test:unit -- --coverage --watchAll=false

      - name: Upload coverage
        uses: codecov/codecov-action@v3
        with:
          file: apps/mobile/coverage/lcov.info

  e2e-tests:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3

      - name: Install dependencies
        run: |
          cd apps/mobile
          npm ci

      - name: Build iOS app for testing
        run: |
          cd apps/mobile
          pnpm exec detox build --configuration ios.sim.debug

      - name: Run E2E tests
        run: |
          cd apps/mobile
          pnpm exec detox test --configuration ios.sim.debug --cleanup
```

---

# API Testing (apps/api/)

## Test Framework Setup

### Unit & Integration Testing
```bash
# Dependencies
pnpm add -D jest @nestjs/testing supertest

# Test configuration
{
  "scripts": {
    "test": "jest",
    "test:watch": "jest --watch",
    "test:cov": "jest --coverage",
    "test:debug": "node --inspect-brk -r tsconfig-paths/register -r ts-node/register node_modules/.bin/jest --runInBand",
    "test:e2e": "jest --config ./test/jest-e2e.json"
  }
}
```

### Database Testing Setup
```typescript
// test/database-test.module.ts
import { TypeOrmModule } from '@nestjs/typeorm';

export const DatabaseTestModule = TypeOrmModule.forRoot({
  type: 'sqlite',
  database: ':memory:',
  entities: [__dirname + '/../src/**/*.entity{.ts,.js}'],
  synchronize: true,
});
```

## Critical Test Scenarios

### Service Layer Tests
```typescript
// src/expenses/expenses.service.spec.ts
describe('ExpensesService', () => {
  let service: ExpensesService;
  let repository: Repository<Expense>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [DatabaseTestModule],
      providers: [ExpensesService],
    }).compile();

    service = module.get<ExpensesService>(ExpensesService);
    repository = module.get<Repository<Expense>>(getRepositoryToken(Expense));
  });

  describe('createExpense', () => {
    it('should create expense with valid data', async () => {
      const createExpenseDto = {
        title: 'Test Expense',
        amount: 25.50,
        categoryId: 'category-1',
        splitType: 'equal',
        splits: [
          { userId: 'user-1', amount: 12.75 },
          { userId: 'user-2', amount: 12.75 }
        ]
      };

      const result = await service.create(createExpenseDto, 'user-1');

      expect(result.title).toBe('Test Expense');
      expect(result.amount).toBe(25.50);
      expect(result.splits).toHaveLength(2);
    });

    it('should validate split amounts equal total', async () => {
      const invalidDto = {
        title: 'Invalid',
        amount: 100,
        splits: [
          { userId: 'user-1', amount: 40 },
          { userId: 'user-2', amount: 50 } // Total: 90, not 100
        ]
      };

      await expect(service.create(invalidDto, 'user-1'))
        .rejects.toThrow('Split amounts must equal total expense amount');
    });

    it('should enforce couple permissions', async () => {
      const expense = { title: 'Test', amount: 50 };

      await expect(service.create(expense, 'unauthorized-user'))
        .rejects.toThrow('User not authorized for this couple');
    });
  });

  describe('findByCoupleId', () => {
    it('should return only couple expenses', async () => {
      // Create test data
      await repository.save([
        { title: 'Couple 1 Expense', coupleId: 'couple-1' },
        { title: 'Couple 2 Expense', coupleId: 'couple-2' }
      ]);

      const result = await service.findByCoupleId('couple-1');

      expect(result).toHaveLength(1);
      expect(result[0].title).toBe('Couple 1 Expense');
    });

    it('should support pagination', async () => {
      // Create 25 test expenses
      const expenses = Array.from({ length: 25 }, (_, i) => ({
        title: `Expense ${i}`,
        amount: 10,
        coupleId: 'couple-1'
      }));
      await repository.save(expenses);

      const page1 = await service.findByCoupleId('couple-1', { page: 1, limit: 10 });
      const page2 = await service.findByCoupleId('couple-1', { page: 2, limit: 10 });

      expect(page1.data).toHaveLength(10);
      expect(page2.data).toHaveLength(10);
      expect(page1.total).toBe(25);
    });
  });
});
```

### Controller Integration Tests
```typescript
// src/expenses/expenses.controller.spec.ts
describe('ExpensesController (Integration)', () => {
  let app: INestApplication;
  let authToken: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule], // Full app context
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    // Get auth token for testing
    const loginResponse = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'test@example.com', password: 'password123' });

    authToken = loginResponse.body.access_token;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /expenses', () => {
    it('should create expense with authentication', () => {
      return request(app.getHttpServer())
        .post('/expenses')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          title: 'API Test Expense',
          amount: 75.25,
          categoryId: 'category-1'
        })
        .expect(201)
        .expect(res => {
          expect(res.body.title).toBe('API Test Expense');
          expect(res.body.amount).toBe(75.25);
        });
    });

    it('should reject unauthenticated requests', () => {
      return request(app.getHttpServer())
        .post('/expenses')
        .send({ title: 'Unauthorized', amount: 50 })
        .expect(401);
    });

    it('should validate request body', () => {
      return request(app.getHttpServer())
        .post('/expenses')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ title: '', amount: -10 }) // Invalid data
        .expect(400)
        .expect(res => {
          expect(res.body.message).toContain('title should not be empty');
          expect(res.body.message).toContain('amount must be a positive number');
        });
    });
  });

  describe('GET /expenses', () => {
    it('should return user expenses with pagination', () => {
      return request(app.getHttpServer())
        .get('/expenses?page=1&limit=5')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200)
        .expect(res => {
          expect(res.body.data).toBeInstanceOf(Array);
          expect(res.body.meta.page).toBe(1);
          expect(res.body.meta.limit).toBe(5);
        });
    });

    it('should filter expenses by date range', () => {
      return request(app.getHttpServer())
        .get('/expenses?start_date=2025-09-01&end_date=2025-09-30')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200)
        .expect(res => {
          res.body.data.forEach(expense => {
            const expenseDate = new Date(expense.date);
            expect(expenseDate >= new Date('2025-09-01')).toBeTruthy();
            expect(expenseDate <= new Date('2025-09-30')).toBeTruthy();
          });
        });
    });
  });
});
```

### Database Integration Tests
```typescript
// test/database.e2e-spec.ts
describe('Database Integration', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    dataSource = app.get(DataSource);
    await app.init();
  });

  describe('Expense Entity Relationships', () => {
    it('should enforce foreign key constraints', async () => {
      const expense = new Expense();
      expense.title = 'Test';
      expense.amount = 50;
      expense.coupleId = 'non-existent-couple';

      await expect(dataSource.manager.save(expense))
        .rejects.toThrow(); // Foreign key violation
    });

    it('should cascade delete expense splits', async () => {
      // Create expense with splits
      const expense = await dataSource.manager.save(Expense, {
        title: 'Test',
        amount: 100,
        coupleId: 'test-couple'
      });

      await dataSource.manager.save(ExpenseSplit, [
        { expenseId: expense.id, userId: 'user-1', amount: 50 },
        { expenseId: expense.id, userId: 'user-2', amount: 50 }
      ]);

      // Delete expense
      await dataSource.manager.delete(Expense, expense.id);

      // Verify splits were deleted
      const splits = await dataSource.manager.find(ExpenseSplit, {
        where: { expenseId: expense.id }
      });
      expect(splits).toHaveLength(0);
    });
  });

  describe('Performance Tests', () => {
    it('should handle concurrent expense creation', async () => {
      const promises = Array.from({ length: 10 }, (_, i) =>
        dataSource.manager.save(Expense, {
          title: `Concurrent ${i}`,
          amount: 10 + i,
          coupleId: 'test-couple'
        })
      );

      const results = await Promise.all(promises);
      expect(results).toHaveLength(10);

      // Verify all expenses were saved
      const count = await dataSource.manager.count(Expense, {
        where: { coupleId: 'test-couple' }
      });
      expect(count).toBeGreaterThanOrEqual(10);
    });
  });
});
```

---

# Web App Testing (apps/web/)

## Test Framework Setup

### Unit & Integration Testing
```bash
# Dependencies
pnpm add -D jest @testing-library/react @testing-library/jest-dom

# Jest configuration
{
  "scripts": {
    "test": "jest",
    "test:watch": "jest --watch",
    "test:coverage": "jest --coverage"
  }
}
```

### End-to-End Testing
```bash
# Playwright setup
pnpm add -D @playwright/test

# playwright.config.ts
export default {
  testDir: './e2e',
  use: {
    baseURL: 'http://localhost:3000',
    headless: true,
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'mobile', use: { ...devices['iPhone 12'] } },
  ],
};
```

## Critical Test Scenarios

### Component Tests
```typescript
// components/__tests__/ExpenseForm.test.tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ExpenseForm from '../ExpenseForm';

describe('ExpenseForm', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } }
    });
  });

  const renderWithProviders = (component) => {
    return render(
      <QueryClientProvider client={queryClient}>
        {component}
      </QueryClientProvider>
    );
  };

  it('should submit form with valid data', async () => {
    const onSubmit = jest.fn();
    renderWithProviders(<ExpenseForm onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Web Test Expense' }
    });
    fireEvent.change(screen.getByLabelText('Amount'), {
      target: { value: '99.99' }
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save Expense' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        title: 'Web Test Expense',
        amount: 99.99,
        // ... other expected data
      });
    });
  });

  it('should show validation errors', async () => {
    renderWithProviders(<ExpenseForm onSubmit={jest.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Save Expense' }));

    await waitFor(() => {
      expect(screen.getByText('Title is required')).toBeInTheDocument();
      expect(screen.getByText('Amount must be greater than 0')).toBeInTheDocument();
    });
  });
});
```

### Page Tests
```typescript
// app/dashboard/expenses/__tests__/page.test.tsx
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ExpensesPage from '../page';

// Mock the API calls
jest.mock('../../../lib/api', () => ({
  getExpenses: jest.fn(() => Promise.resolve({
    data: [
      { id: '1', title: 'Test Expense', amount: 50.00, date: '2025-09-19' }
    ],
    meta: { total: 1, page: 1, limit: 10 }
  }))
}));

describe('ExpensesPage', () => {
  it('should render expenses list', async () => {
    const queryClient = new QueryClient();

    render(
      <QueryClientProvider client={queryClient}>
        <ExpensesPage />
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('Test Expense')).toBeInTheDocument();
      expect(screen.getByText('$50.00')).toBeInTheDocument();
    });
  });
});
```

### End-to-End Tests
```typescript
// e2e/expense-management.spec.ts
import { test, expect } from '@playwright/test';

test.describe('Expense Management', () => {
  test.beforeEach(async ({ page }) => {
    // Login before each test
    await page.goto('/login');
    await page.fill('[data-testid="email-input"]', 'test@example.com');
    await page.fill('[data-testid="password-input"]', 'password123');
    await page.click('[data-testid="login-button"]');
    await expect(page).toHaveURL('/dashboard');
  });

  test('should create new expense', async ({ page }) => {
    await page.goto('/dashboard/expenses');

    // Click add expense button
    await page.click('[data-testid="add-expense-button"]');

    // Fill expense form
    await page.fill('[data-testid="expense-title"]', 'E2E Test Expense');
    await page.fill('[data-testid="expense-amount"]', '125.50');

    // Select category
    await page.click('[data-testid="category-select"]');
    await page.click('text=Food & Dining');

    // Submit form
    await page.click('[data-testid="save-expense-button"]');

    // Verify expense appears in list
    await expect(page.locator('text=E2E Test Expense')).toBeVisible();
    await expect(page.locator('text=$125.50')).toBeVisible();
  });

  test('should filter expenses by date range', async ({ page }) => {
    await page.goto('/dashboard/expenses');

    // Open date filter
    await page.click('[data-testid="date-filter-button"]');

    // Set date range
    await page.fill('[data-testid="start-date"]', '2025-09-01');
    await page.fill('[data-testid="end-date"]', '2025-09-30');
    await page.click('[data-testid="apply-filter"]');

    // Verify filtered results
    const expenses = page.locator('[data-testid="expense-item"]');
    const count = await expenses.count();
    expect(count).toBeGreaterThan(0);

    // Verify all expenses are within date range
    for (let i = 0; i < count; i++) {
      const dateText = await expenses.nth(i).locator('[data-testid="expense-date"]').textContent();
      const expenseDate = new Date(dateText);
      expect(expenseDate >= new Date('2025-09-01')).toBeTruthy();
      expect(expenseDate <= new Date('2025-09-30')).toBeTruthy();
    }
  });

  test('should export expenses to CSV', async ({ page }) => {
    await page.goto('/dashboard/expenses');

    // Start download
    const downloadPromise = page.waitForEvent('download');
    await page.click('[data-testid="export-csv-button"]');
    const download = await downloadPromise;

    // Verify download
    expect(download.suggestedFilename()).toContain('expenses');
    expect(download.suggestedFilename()).toContain('.csv');
  });
});

test.describe('Responsive Design', () => {
  test('should work on mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/dashboard');

    // Test mobile navigation
    await page.click('[data-testid="mobile-menu-button"]');
    await expect(page.locator('[data-testid="mobile-nav"]')).toBeVisible();

    // Test expense creation on mobile
    await page.click('text=Expenses');
    await page.click('[data-testid="add-expense-fab"]');

    await expect(page.locator('[data-testid="expense-form"]')).toBeVisible();
  });
});
```

---

# Test Data Management

## Test Fixtures
```typescript
// test/fixtures/expenses.ts
export const expenseFixtures = {
  validExpense: {
    title: 'Test Expense',
    amount: 25.50,
    category: { id: '1', name: 'Food', color: '#FF5722' },
    date: '2025-09-19'
  },

  groupExpense: {
    title: 'Group Dinner',
    amount: 120.00,
    groupId: 'group-1',
    paidBy: 'user-1',
    splitBetween: ['user-1', 'user-2']
  },

  expenseList: [
    { id: '1', title: 'Coffee', amount: 4.50, date: '2025-09-19' },
    { id: '2', title: 'Lunch', amount: 12.75, date: '2025-09-18' },
    { id: '3', title: 'Gas', amount: 45.00, date: '2025-09-17' }
  ]
};
```

## Database Seeding for Tests
```typescript
// test/seeds/test-data.ts
export async function seedTestData(dataSource: DataSource) {
  // Clear existing data
  await dataSource.manager.clear(Expense);
  await dataSource.manager.clear(Couple);
  await dataSource.manager.clear(User);

  // Create test users
  const users = await dataSource.manager.save(User, [
    { id: 'user-1', email: 'test1@example.com', username: 'user1' },
    { id: 'user-2', email: 'test2@example.com', username: 'user2' }
  ]);

  // Create test couple
  const couple = await dataSource.manager.save(Couple, {
    id: 'couple-1',
    user1Id: 'user-1',
    user2Id: 'user-2'
  });

  // Create test categories
  await dataSource.manager.save(Category, [
    { id: 'cat-1', name: 'Food & Dining', color: '#FF5722', coupleId: 'couple-1' },
    { id: 'cat-2', name: 'Transportation', color: '#2196F3', coupleId: 'couple-1' }
  ]);

  // Create test expenses
  await dataSource.manager.save(Expense, [
    {
      title: 'Test Expense 1',
      amount: 50.00,
      coupleId: 'couple-1',
      categoryId: 'cat-1',
      paidBy: 'user-1'
    }
  ]);
}
```

---

# Continuous Integration & Quality Gates

## GitHub Actions Workflow
```yaml
# .github/workflows/test-all.yml
name: Test All Applications

on:
  pull_request:
  push:
    branches: [main]

jobs:
  mobile-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'

      - name: Install dependencies
        run: |
          pnpm install --filter mobile --frozen-lockfile

      - name: Run unit tests
        run: |
          pnpm --filter mobile run test -- --coverage --watchAll=false

      - name: Check coverage threshold
        run: |
          pnpm --filter mobile run test:coverage-check

  api-tests:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:15
        env:
          POSTGRES_PASSWORD: test
          POSTGRES_DB: test
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3

      - name: Install dependencies
        run: |
          pnpm install --filter api --frozen-lockfile

      - name: Run unit tests
        run: |
          pnpm --filter api run test

      - name: Run integration tests
        run: |
          pnpm --filter api run test:e2e
        env:
          DATABASE_URL: postgresql://postgres:test@localhost:5432/test

  web-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3

      - name: Install dependencies
        run: |
          pnpm install --filter web --frozen-lockfile

      - name: Run unit tests
        run: |
          pnpm --filter web run test

      - name: Build application
        run: |
          pnpm --filter web run build

      - name: Run E2E tests
        run: |
          pnpm exec playwright test

  e2e-integration:
    runs-on: ubuntu-latest
    needs: [mobile-tests, api-tests, web-tests]
    if: github.event_name == 'pull_request'

    steps:
      - name: Run full integration tests
        run: echo "Full integration test suite"
        # Would include cross-app integration tests
```

## Quality Gates
- **Unit Test Coverage**: Minimum 80% for mobile, 90% for API
- **Integration Tests**: All critical paths must pass
- **E2E Tests**: Core user journeys must pass
- **Performance**: No regression in load times
- **Security**: Vulnerability scanning must pass
- **Code Quality**: ESLint and TypeScript checks must pass

This comprehensive testing strategy ensures quality across all applications while supporting efficient development workflows.
