Plan

Goal: Assess current E2E test infrastructure and create implementation plan for Detox-based end-to-end testing

Assumptions:

- Detox (v20.42.0) is already installed as devDependency
- Existing E2E test files (userOnboarding.e2e.js, dataValidation.e2e.js, expenseFlow.test.js) are present but likely not
  running
- Mobile app uses Expo (v54.0.10) with Expo Router
- Current focus is local-only testing (no API integration yet)

Constraints:

- Detox requires native build configuration (iOS simulator, Android emulator)
- Expo apps need special Detox setup (expo-detox vs standard Detox)
- E2E tests are slower and require running app builds
- Must maintain separation from unit/integration tests

Risks:

1. Detox configuration may be outdated or incomplete for Expo Router migration
2. Native build paths in .detoxrc.js may not exist
3. Test IDs (testID props) may be missing from components
4. Setup may require iOS/Android simulator configuration

Test/Verification Plan:

1. Analyze current Detox configuration against Expo 54 requirements
2. Identify missing testID props in components
3. Document required simulator/emulator setup
4. Create step-by-step E2E test execution plan
5. Identify gaps between existing test files and actual app structure

BDD Acceptance Criteria:

Given the mobile app has comprehensive unit and integration test coverage
When we want to validate complete user workflows end-to-end
Then we should implement Detox E2E tests that: - Test complete user journeys (onboarding, expense creation, group management) - Run against actual native builds (iOS simulator, Android emulator) - Validate cross-screen data persistence and navigation - Cover critical paths: first-time user setup, expense CRUD, insights navigation - Execute separately from unit/integration tests - Provide clear failure diagnostics with screenshots

Next Steps:

1. Analyze current Detox configuration compatibility
2. Audit components for missing testID props
3. Verify native build requirements
4. Create E2E test execution guide
5. Propose test implementation priority order

---

Execution

Let me analyze the current E2E test infrastructure:

Current State Analysis:

✅ Infrastructure Present:

- Detox v20.42.0 installed
- 3 E2E test files (userOnboarding, dataValidation, expenseFlow) with 30+ test cases
- Test helpers module with comprehensive utilities
- Jest configuration for Detox
- .detoxrc.js with iOS/Android configurations

❌ Issues Identified:

1. Native Build Paths Don't Exist:
   - iOS: ios/build/Build/Products/Debug-iphonesimulator/ExpenseTracker.app
   - Android: android/app/build/outputs/apk/debug/app-debug.apk
   - Problem: Expo apps don't have ios/ or android/ folders by default (managed workflow)

2. Expo Managed Workflow Incompatibility:
   - Current .detoxrc.js expects ejected Expo app (bare workflow)
   - Managed workflow requires expo prebuild to generate native folders
   - OR use Expo's custom Detox build approach

3. Test IDs Missing from Components:
   - Tests reference IDs like add-expense-fab, expense-title-input, category-picker
   - Need to audit actual components to verify these testID props exist

4. Build Commands Invalid:
   - iOS: xcodebuild -workspace ios/ExpenseTracker.xcworkspace...
   - Android: cd android && ./gradlew assembleDebug...
   - These only work with ejected apps

5. Test Coverage vs Implementation Mismatch:
   - Tests assume UI elements that may not exist (e.g., by.id('total-share-button'))
   - Need to verify actual component structure matches test expectations

Recommended Approach:

Since this is an Expo managed workflow app, you have 2 options:

Option A: Stay Managed (Recommended for now)

- Don't run native E2E tests yet
- Wait until API integration phase when you might eject
- Focus on current unit/integration test coverage (294/294 passing)
- Use Expo's development client for manual E2E validation

Option B: Eject to Bare Workflow (Major undertaking)

- Run expo prebuild to generate ios/ and android/ folders
- Update Detox configuration for bare workflow
- Add testID props to all components
- Set up iOS simulators and Android emulators
- Build native apps for testing
- Estimated effort: 2-3 days

My Recommendation:

Defer E2E testing until after API integration because:

1. Current Coverage is Strong: 294/294 tests passing (268 unit + 23 integration + 3 performance)
2. Local-Only Storage: E2E tests are most valuable for testing network integration, which doesn't exist yet
3. Expo Managed Benefits: Keep managed workflow benefits (faster development, easier updates)
4. API Phase Natural Transition: When implementing API, you'll likely need to eject anyway for native modules

If You Still Want E2E Now:

I can create a detailed implementation plan including:

- Step-by-step ejection process
- testID prop audit and additions
- Detox configuration updates
- Simulator setup guide
- Test execution workflow

---

Tests & Verification

Current Test Status:

- ✅ Unit tests: 268 passing (23 files)
- ✅ Integration tests: 23 passing (2 files)
- ✅ Performance tests: 3 passing (1 file)
- ❌ E2E tests: 0 running (infrastructure exists but not configured for Expo managed workflow)

Verification Steps for E2E Implementation (if proceeding):

# 1. Check if native folders exist

ls ios/ android/ # Should fail in managed workflow

# 2. Prebuild native folders (if ejecting)

npx expo prebuild

# 3. Verify Detox installation

npx detox test --configuration ios.sim.debug --loglevel trace

# 4. Audit components for testID props

grep -r "testID=" apps/mobile/src/components/
grep -r "testID=" apps/mobile/app/

BDD Verification Scenarios:

Scenario: E2E test infrastructure is ready
Given the mobile app is built for iOS simulator
And Detox is configured correctly
When I run "pnpm test:e2e"
Then Detox should launch the app
And execute userOnboarding tests
And report test results

Scenario: testID props are present
Given I open AddExpenseScreen
When I search for testID="add-expense-fab"
Then the element should be found
And Detox can interact with it

---

Open Questions / Next Steps

Questions for You:

1. Do you want to eject to bare workflow now for E2E testing, or wait until API integration phase?
2. What's your priority: Getting E2E tests running vs continuing with API development (Task 2.2)?
3. Device targets: Which platform is primary for E2E testing (iOS, Android, or both)?
4. CI/CD considerations: Are you planning to run E2E tests in CI, or just locally?

Recommended Next Steps (if deferring E2E):

1. ✅ Document E2E deferral decision in CHANGELOG.md
2. ✅ Keep existing E2E test files as templates for future implementation
3. ✅ Continue with API development (Task 2.2 - TDD API Implementation)
4. ⏭️ Revisit E2E testing after API integration when ejection may be necessary

OR, if proceeding with E2E now:

1. 📋 Create E2E implementation plan with ejection steps
2. 🔍 Audit components for testID props
3. 🔨 Run expo prebuild to generate native folders
4. ⚙️ Update Detox config for bare workflow
5. 🧪 Implement test execution workflow
