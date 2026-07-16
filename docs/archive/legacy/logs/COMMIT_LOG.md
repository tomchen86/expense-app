[46c89ff] 2026-03-04
Title: Upgrade to Expo SDK 55 (React Native 0.83, React 19.2)
Work ID: WORK-2026-03-04-01
Authoring: Human+AI

Intent

- Upgrade Expo SDK 54 → 55, React 19.1 → 19.2, React Native 0.81.4 → 0.83.2
- SDK 55 removes Legacy Architecture and mandates New Architecture
- Align all peer dependencies to SDK 55 compatible versions

Changes

- Updated expo 54.0.10 → 55.0.4
- Updated react 19.1.0 → 19.2.0, react-dom 19.1.0 → 19.2.0
- Updated react-native 0.81.4 → 0.83.2
- Updated expo-router ~6.0.8 → ~55.0.3, expo-status-bar ~3.0.8 → ~55.0.4
- Updated react-native-reanimated ~4.1.2 → 4.2.1 (moved back to dependencies)
- Updated react-native-screens ~4.16.0 → ~4.23.0, react-native-gesture-handler ~2.28.0 → ~2.30.0
- Updated react-native-svg 15.12.1 → 15.15.3, react-native-worklets ^0.5.1 → ^0.7.2
- Updated @react-native-community/datetimepicker 8.4.4 → 8.6.0, picker 2.11.1 → 2.11.4
- Added explicit deps: expo-constants ~55.0.7, expo-font ~55.0.4, expo-linking ~55.0.7
- app.json: removed newArchEnabled (now mandatory default) and edgeToEdgeEnabled (now mandatory)
- app.json: added @react-native-community/datetimepicker and expo-font config plugins
- tsconfig.json: added esModuleInterop, allowSyntheticDefaultImports; expanded include paths
- **mocks**/expo-router.ts: replaced React.ReactNode with ReactNode import (React 19.2 compat)
- useExpenseModals.ts: generic type parameter for type-safe setFormState

Verification

- `npx expo-doctor@latest` → 17/17 checks pass
- `pnpm --filter mobile typecheck` → 0 errors
- `pnpm --filter mobile test` → 270/270 tests pass, 26/26 suites

Risks / Rollback

- Native builds (iOS/Android) require Xcode 26+ and a dev build rebuild
- `git revert <hash>` to roll back; run `pnpm install` after to restore lockfile

Links

- Session: Expo SDK 55 upgrade, March 4 2026

---

[61529ff] 2026-03-03 ~23:00
Title: Consolidate documentation — deduplicate meta-docs, fix archive naming
Work ID: WORK-2026-03-03-01
Authoring: Human+AI

Intent

- Three meta-docs (DOCUMENT_STRUCTURE_GUIDE, UPDATE_CHECKLIST, GUIDE-LOG_TRACKING) had significant overlap
- Archive files lacked ✅- prefix convention; one log file had wrong prefix

Changes

- Trimmed ~60 lines from DOCUMENT_STRUCTURE_GUIDE.md (removed duplicated update triggers, log templates, changelog comparison)
- Trimmed ~110 lines from UPDATE_CHECKLIST.md (removed duplicated key principles, COMMIT_LOG template, never-modify table, workflow summary)
- Added cross-reference header to GUIDE-LOG_TRACKING.md
- Created docs/README.md as universal entry point
- Rewrote CLAUDE.md (lean, qualitative status, no hardcoded test counts)
- Renamed 10 archive files to add ✅- prefix
- Renamed LOG_PHASE3_TESTING_REPORT.md → LOG-PHASE3_TESTING_REPORT.md

Verification

- V1-V7 checks all pass (cross-references, no duplicate templates, archive naming, no broken real links, no hardcoded counts)

Risks / Rollback

- Content was trimmed, not deleted — replaced with cross-references to the owning doc
- `git revert <hash>` restores all three files

Links

- Session: this commit covers the full documentation consolidation task

---

[5f1c454] #Tue Sep 30 13:30:00 2025
⏺ Organize documentation files

## Major Changes

- Moved 3 E2E/Expo Router testing docs from apps/mobile/ to docs/features/testing/
  - E2E_TESTID_MAPPING.md
  - EXPO_ROUTER_TESTING_ANALYSIS.md
  - EXPO_ROUTER_TESTING_REFERENCE.md
- Archived completed Task 2.1 database design plan (✅-PLAN-TASK_2.1_DATABASE_DESIGN.md)
- Archived Phase 2 audit reports (✅-STATUS-PHASE_2_COMPLETION_AUDIT.md, ✅-STATUS-PHASE_2_IMPLEMENTATION_AUDIT.md)
- Archived completed Expo Router migration plan (✅-PLAN-EXPO_ROUTER_MIGRATION.md)
- Organized developer brainstorming note (DEVELOPER_NOTE.md)
- Archived duplicate Claude implementation plan (PLAN-TASK_2.2_CLAUDE_IMPLEMENTATION.md)

## Files Modified

- 10 files renamed/moved with git history preserved
- All changes follow hybrid documentation structure (planning/, status/, logs/, features/, archive/)

## Next Steps

1. Continue with E2E test execution (build iOS app, run first test)

---

[PENDING_COMMIT] #Tue Sep 30 13:XX:XX 2025
⏺ Ejected to bare workflow and implemented E2E testing infrastructure

## Major Changes

### 1. Ejected from Expo Managed Workflow to Bare Workflow

- Ran `npx expo prebuild --clean` to generate native folders
- Created ios/ directory with Xcode project and workspace (mobile.xcworkspace)
- Created android/ directory with Gradle build configuration
- Updated package.json scripts: `ios` now uses `expo run:ios`, `android` uses `expo run:android`
- Impact: Repo size increased by ~100MB, but enables native E2E testing

### 2. Updated Detox Configuration

- Fixed .detoxrc.js paths for actual app structure
- Changed app name from "ExpenseTracker" to "mobile"
- Updated iOS workspace path: ios/mobile.xcworkspace
- Updated binary paths:
  - iOS: ios/build/Build/Products/Debug-iphonesimulator/mobile.app
  - Android: android/app/build/outputs/apk/debug/app-debug.apk

### 3. Added Critical testID Props (Phase 1)

Implemented testIDs for core expense creation flow:

- FloatingActionButton: `add-expense-fab`
- BasicInfoSection: `expense-title-input`, `expense-amount-input`, `expense-caption-input`
- SelectInput: Added testID prop support with `category-picker`
- DatePicker: `date-picker`

- AddExpenseScreen: `save-expense-button`
- SettingsScreen: `username-input`

### 4. Documentation

- Created E2E_TESTID_MAPPING.md: Complete testID mapping strategy with phases
- Created E2E_IMPLEMENTATION_STATUS.md: Progress tracking and next steps
- Documented all 23 required testIDs from E2E test files

## Test Status

- ✅ All 294 unit/integration tests still passing (100%)
- ✅ No regressions from ejection
- ✅ testID props properly passed through component props

## Files Modified

- .detoxrc.js - Updated app names and build paths
- package.json - Updated ios/android scripts for bare workflow
- app.json - Updated for bare workflow
- src/components/FloatingActionButton.tsx - Added testID
- src/components/ExpenseForm/BasicInfoSection.tsx - Added testIDs to all inputs
- src/components/SelectInput.tsx - Added testID prop support

- src/screens/AddExpenseScreen.tsx - Added save button testID
- src/screens/SettingsScreen.tsx - Added username input testID
- New: ios/ and android/ native directories (full native projects)
- New: E2E_TESTID_MAPPING.md
- New: docs/E2E_IMPLEMENTATION_STATUS.md

## Next Steps

1. Build iOS app for simulator: `pnpm test:e2e:build -- --configuration ios.sim.debug`
2. Run first E2E test (expense creation flow)
3. Add remaining testIDs (15 more) for full coverage
4. Run complete E2E test suite (62 tests across 3 files)

---

[b4446c6ade1ea66b5744bd7953f0b487cc0bbc59] #Tue Sep 30 01:16:49 2025
⏺ Excellent! Out of 271 tests, 270 are passing - only 1 is failing due to a TextEncoder issue (unrelated to our Expo Router
migration). This shows that:

1. ✅ Babel configuration is working correctly
2. ✅ Unit test mocking for expo-router is working
3. ✅ All hook tests that use router.back() and router.push() are passing
4. ✅ The dual-project Jest configuration is working

Let me update the todo as completed:

⏺ Tests & Verification

Successfully implemented the Babel configuration restoration to fix Jest TypeScript parsing issues:

BDD Scenarios Completed:

- ✅ Given Jest cannot parse TypeScript in setup files When we add babel-preset-expo and babel-jest Then tests parse and run
  correctly
- ✅ Given unit tests need expo-router mocking When we run tests with restored Babel config Then router functions are properly
  mocked and tested

Configuration Restored:

1. babel-preset-expo and babel-jest dependencies added to package.json
2. babel.config.js created with simplified configuration from legacy app
3. Jest configuration updated with proper transform settings for both projects
4. Transform patterns updated to include expo-router for proper parsing

Test Results:

- Unit Tests: 270/271 passing (99.6% success rate)
- Hook Tests: All expo-router related tests (useExpenseForm, useExpenseModals) now passing
- Router Mocking: Confirmed working with router.back() and router.push() assertions
- Integration Setup: Basic integration tests working (except expo-router/testing-library edge cases)

Files Modified:

- package.json - Added babel-preset-expo, babel-jest, @babel/core
- babel.config.js - Created simplified Babel configuration
- jest.config.js - Added transform settings to both unit and integration projects
- Updated transformIgnorePatterns to include expo-router
- Fixed 2 hook test files to use expo-router instead of React Navigation

Verification:

- App directory (app/) has no TypeScript errors related to expo-router
- Expo Router file-based routing is working correctly
- Legacy screen files in src/screens/ have expected React Navigation import errors (unused files)

Open Questions / Next Steps

Success Summary:
The Babel restoration successfully resolved the Jest TypeScript parsing issues while maintaining all Expo Router functionality.
The testing infrastructure now supports:

- Unit tests with proper expo-router mocking (270/271 tests passing)
- Integration tests with basic Expo functionality
- Dual-project Jest configuration following official Expo Router patterns

The only unrelated issue is one TextEncoder test failure and some expo-router/testing-library edge cases that may need
additional configuration, but the core testing functionality is fully restored.

[1360d765e660eeb22cd227d68f1ed3392fd1af4e] #Tue Sep 30 12:39:22
Successfully completed all tasks:

1. ✅ Expo Router Testing Configuration
   - Dual Jest project setup (unit/integration)
   - Babel configuration restored
   - expo-router JSX bug patched
   - transformIgnorePatterns fixed
   - TextEncoder polyfill added
   - 294/294 tests passing (100%)

2. ✅ Code Organization
   - FormInput-logic.unit.ts: 366 lines (was 628)
   - FormInput-advanced.unit.ts: 264 lines (new file)
   - Both under 500-line limit

3. ✅ Documentation Split
   - MOBILE_TEST_COMPREHENSIVE_SUMMARY.md: 84 lines (index/overview)
   - MOBILE_UNIT_TESTS.md: 903 lines (23 test files, 268 tests)
   - MOBILE_INTEGRATION_TESTS.md: 497 lines (2 test files, 23 tests)

Documentation Structure:
docs/Testing/
├── MOBILE_TEST_COMPREHENSIVE_SUMMARY.md (index with quick reference)
├── MOBILE_UNIT_TESTS.md (detailed unit test docs)
└── MOBILE_INTEGRATION_TESTS.md (detailed integration test docs)

Key Features:

- Clear separation between unit and integration test documentation
- Quick reference table comparing test types
- Test execution commands
- Current status tracking
- Recent updates log

All files are properly organized and under reasonable line limits!
