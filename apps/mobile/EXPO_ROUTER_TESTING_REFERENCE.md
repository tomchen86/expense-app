# Expo Router Testing Reference

> **Quick Reference**: For AI assistance with Expo Router testing configuration, refer to the official documentation: https://docs.expo.dev/router/reference/testing/

## Why This Reference Exists

This file serves as a reminder for AI assistants working on this project that we have successfully implemented Expo Router testing using the official Expo documentation patterns. When encountering testing issues or questions about Expo Router, always refer to the official guide first.

## What We've Successfully Implemented

✅ **Dual Jest Projects Configuration**

- Unit tests with mocked expo-router
- Integration tests with real expo-router functionality

✅ **Proper Test Organization**

- Tests kept OUTSIDE `app/` directory
- Clear separation between `.unit.(ts|tsx)` and `.int.(ts|tsx)` files

✅ **Official Testing Patterns**

- `renderRouter()` with inline file system mocking
- `initialUrl` for deep link testing
- Custom Jest matchers (`toHavePathname()`, `toHaveSegments()`, etc.)

✅ **TypeScript-Safe Mocking**

- Comprehensive mock in `__mocks__/expo-router.ts`
- Per-suite mocking strategy (not global)

## Key Documentation Insights Applied

### From https://docs.expo.dev/router/reference/testing/

1. **No Separate Package Installation**

   ```typescript
   // ✅ Correct - submodule import
   import { renderRouter } from 'expo-router/testing-library';

   // ❌ Wrong - don't install as separate package
   // pnpm add -D expo-router/testing-library
   ```

2. **File System Mocking Patterns**

   ```typescript
   // Inline FS with initialUrl
   await renderRouter(
     {
       'app/_layout': LayoutComponent,
       'app/index': HomeComponent,
       'app/expenses/[id]': ExpenseDetailComponent,
     },
     {
       initialUrl: '/expenses/123',
     },
   );
   ```

3. **Custom Jest Matchers**

   ```typescript
   expect(screen).toHavePathname('/expenses/123');
   expect(screen).toHaveSegments(['expenses', '123']);
   ```

4. **Test Location Requirements**
   - All tests MUST be outside `app/` directory
   - Expo Router requires every file in `app/` to be a route or layout

## Project-Specific Implementation

### Jest Configuration

```javascript
// jest.config.js - Two projects approach
module.exports = {
  preset: 'jest-expo',
  projects: [
    {
      displayName: 'unit',
      testMatch: ['<rootDir>/**/__tests__/**/*.unit.(ts|tsx)'],
      setupFilesAfterEnv: ['<rootDir>/jest.setup.unit.ts'],
    },
    {
      displayName: 'integration',
      testMatch: ['<rootDir>/**/__tests__/**/*.int.(ts|tsx)'],
      setupFilesAfterEnv: ['<rootDir>/jest.setup.int.ts'],
    },
  ],
  // NO moduleNameMapper for expo-router
};
```

### Our Test Files Structure

```
__tests__/
├── hooks/
│   ├── useExpenseForm.unit.tsx
│   └── useExpenseModals.unit.tsx
├── components/
│   └── FloatingActionButton.unit.tsx
└── flows/
    ├── expense-creation.int.tsx
    └── navigation.int.tsx
```

## Success Metrics

- **294/294 tests** maintained from React Navigation migration
- **Zero navigation-related test failures** with proper mocking
- **Integration tests** covering critical user flows
- **Type safety** preserved with TypeScript-compatible mocks

## AI Assistant Guidelines

When working on this project's testing:

1. **Always refer to the official Expo Router testing docs first**
2. **Use the two-project Jest configuration we've established**
3. **Keep all tests outside the `app/` directory**
4. **Import `renderRouter` directly from `expo-router/testing-library`**
5. **Don't suggest installing expo-router testing as a separate package**
6. **Use per-suite mocking, not global moduleNameMapper**

## Related Files

- `EXPO_ROUTER_TESTING_ANALYSIS.md` - Detailed implementation plan
- `jest.config.js` - Current Jest configuration
- `jest.setup.unit.ts` - Unit test setup with mocking
- `jest.setup.int.ts` - Integration test setup (no mocking)
- `__mocks__/expo-router.ts` - TypeScript-safe router mock

---

**Remember**: This project successfully follows the official Expo Router testing patterns. When in doubt, check the official docs at the URL above and our proven implementation in this codebase.
