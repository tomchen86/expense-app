# Mobile Test Documentation

> [!IMPORTANT]
> 本文件是 2025 年的測試快照。若要查看目前 Mobile Jest/Detox 的測試檔、實際收集範圍、最新執行結果與 coverage 空白，請改讀 [`../GUIDE-MOBILE-TESTS.md`](../GUIDE-MOBILE-TESTS.md)，並以測試原始碼與最新 runner output 為準。

This document has been split into two focused files for better organization:

## 📋 [Unit Tests](./MOBILE_UNIT_TESTS_SUMMARY.md)

Comprehensive documentation of **23 unit test files** covering:

- **Components** (8 files, 97 tests): Component logic, prop validation, display formatting
- **Utils** (4 files, 47 tests): Business calculations, data transformations
- **Hooks** (4 files, 10 tests): Custom hook behavior, state management
- **Store** (6 files, 42 tests): Zustand store operations, cross-store sync
- **Performance** (1 file, 3 tests): Performance benchmarks, memory efficiency

**Total: 268 unit test cases**

## 🔗 [Integration Tests](./MOBILE_INTEGRATION_TESTS_SUMMARY.md)

Comprehensive documentation of **2 integration test files** covering:

- **SettingsScreen Integration** (13 tests): User onboarding, settings persistence
- **AddExpenseScreen Integration** (10 tests): Expense creation, store integration

**Total: 23 integration test cases**

## Quick Reference

| Aspect           | Unit Tests                | Integration Tests        |
| ---------------- | ------------------------- | ------------------------ |
| **Purpose**      | Isolated logic validation | End-to-end workflows     |
| **Dependencies** | Mocked                    | Real (store, navigation) |
| **Speed**        | Fast (< 3s total)         | Slower (< 10s total)     |
| **Files**        | 23 test files             | 2 test files             |
| **Tests**        | 268 test cases            | 23 test cases            |
| **Focus**        | Logic correctness         | User experience          |

## Test Execution

### Run All Tests

```bash
pnpm test
```

### Run Unit Tests Only

```bash
pnpm test --selectProjects=unit
```

### Run Integration Tests Only

```bash
pnpm test --selectProjects=integration
```

### Run Specific Test File

```bash
pnpm test FormInput
```

## Historical Status (2025-09-30)

- ✅ **Total Test Suites**: 27 passing (28 total including this migration)
- ✅ **Total Tests**: 294 passing
- ✅ **Test Coverage**: 100% pass rate
- ✅ **Expo Router Migration**: Complete with dual Jest configuration

## Documentation Structure

```
docs/features/testing/summary/
├── MOBILE_TEST_OVERVIEW.md                 (this file - index)
├── MOBILE_UNIT_TESTS_SUMMARY.md            (detailed unit test docs)
└── MOBILE_INTEGRATION_TESTS_SUMMARY.md     (detailed integration test docs)
```

## Recent Updates

### 2025-09-30: Expo Router Migration Testing Configuration

- ✅ Implemented dual Jest project configuration (unit/integration)
- ✅ Created separate setup files for unit and integration tests
- ✅ Added Babel configuration (babel-preset-expo, babel-jest)
- ✅ Patched expo-router JSX packaging bug
- ✅ Fixed transformIgnorePatterns for PNPM compatibility
- ✅ Added TextEncoder polyfill for Node.js environment
- ✅ Split FormInput tests into two files (under 500 lines each)
- ✅ Achieved 294/294 tests passing (100%)

For detailed test case descriptions, see the respective unit and integration test documentation files.
