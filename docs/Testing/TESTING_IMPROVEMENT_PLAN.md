# Testing Infrastructure Improvement Plan

*Revised: September 22, 2025*

## Executive Summary
Mobile testing has progressed from utility-only checks to full coverage across the core expense, group, category, and user settings experiences. All Phase 1 and Phase 2 goals for the mobile client are now automated, and Phase 3 quality targets—coverage thresholds, performance visibility, and CI reporting—are operational. Remaining effort focuses on deepening Detox end-to-end trails, extending parity to the API and web apps, and continuously curating high-value regression scenarios.

## Current Metrics
- **Test suites**: 25 mobile suites / 271 assertions passing via `pnpm --filter mobile test:unit`
- **Coverage snapshot**: Statements 95.5 %, Lines 95.5 %, Functions 91.3 %, Branches 86.4 % (`pnpm --filter mobile exec -- jest --testPathIgnorePatterns=integration\.test --coverage`)
- **Coverage gates**: Global thresholds locked at 90 % statements/lines/functions and 80 % branches (`apps/mobile/jest.config.js`)
- **Performance checks**: `src/__tests__/performance/store-performance.test.ts` benchmarks key store operations (thresholds relax automatically under coverage instrumentation)
- **Reports**: HTML SPA coverage reports published to `apps/mobile/coverage/`; bundle analyzer toggled via `ANALYZE_BUNDLE=true`

## Phase Outcomes

### Phase 1 – Core Foundation (Completed)
- **Store test infrastructure**: Suites for expense, composed expense, user, participant, group, and category stores (`apps/mobile/src/store/__tests__/…`) ensure CRUD, synchronization, and legacy bridge logic are validated. (Zustand’s dynamic setters limit line-level instrumentation, but behavioural assertions cover every public action.)
- **Component/hook harnesses**: Shared test setup (`src/__tests__/setup-component.ts`) plus hook harnesses using `react-test-renderer` enable isolation of UI logic.
- **Fixture library**: `src/__tests__/fixtures/index.ts` now serves consistent categories, expenses, groups, and helpers (e.g., `createMockExpense`).

### Phase 2 – Feature Coverage (Substantially Complete)
- **Core flows automated**: Component & screen logic suites cover Category management, History/Home views, FloatingActionButton, ExpenseListItem, Settings, and more.
- **Hook-level behaviour**: `src/hooks/__tests__/useExpenseForm.test.tsx`, `useCategoryManager.test.tsx`, `useExpenseModals.test.tsx`, and `useInsightsData.test.tsx` now exercise the primary decision branches for submission, modal orchestration, and insights navigation—addressing FUNCTION_LOG items for Add/Edit/Delete expense and analytics views.
- **Integration checks**: Screen logic tests emulate key navigation/validation steps without rendering full UI trees.
- **Outstanding**: Author Detox runs for Add/Edit/Delete expense, Group creation, and Insights navigation to satisfy the “critical user journeys” bullet.

### Phase 3 – Quality & Optimization (Completed)
- **Coverage thresholds enforced**: Husky pre-commit, workflow matrix, and coverage job keep global metrics at ≥90 % statements/lines/functions and ≥80 % branches (V8 coverage provider).
- **Performance & reporting**: Store performance benchmarks run alongside coverage reporters (`text-summary`, `html`, `html-spa`); webpack bundle analyzer available on demand.
- **CI resilience**: `.github/workflows/test-mobile.yml` shards by test type, uploads artifacts, and surfaces coverage status in summary comments.
- **Tooling hygiene**: Watchman recrawl warnings occur locally—reset with `watchman watch-del '/Users/htchen/code_base/app' && watchman watch-project '/Users/htchen/code_base/app'` as part of regular maintenance.

### API Database Harness (In Progress)
- **Phase 0 stabilised**: `apps/api/src/__tests__/setup/postgres-test-container.ts` now reuses the Docker Compose Postgres instance when available, cutting setup times from minutes to seconds while keeping the fallback ephemeral cluster for CI isolation.
- **SQLite compatibility guard**: `UserSimple` fixture entity keeps fast sql.js runs green while Postgres tests continue to exercise `citext` behaviour via the canonical `User` entity.
- **Identity specs**: `apps/api/src/__tests__/identity/user-settings.postgres.spec.ts` and `user-auth-identity.postgres.spec.ts` confirm JSON defaults, persistence guardrails, and provider uniqueness, while sqlite mirrors catch regressions without hitting Postgres.

## Next Steps & Backlog
1. **Detox scenarios** – Implement automated flows for Add Expense, Edit Expense, Group Management, and Insights navigation; publish runbook in `docs/Testing/` once stabilized.
2. **Identity follow-up** – Add coverage for `user_devices` plus rollback/seed helpers so the entire Phase 1 schema can run forward/backward under test control.
3. **API/Web parity** – Replicate Phase 1 groundwork for `apps/api/` (NestJS) and `apps/web/` (Next.js) to avoid mobile-only confidence.
4. **Expanded fixtures** – Add multi-currency, localization, and error condition datasets; reference them in upcoming regression tests.
5. **Visual regression** – Evaluate screenshot or component-story diffs for high-impact screens; integrate with bundle analyzer outputs.
6. **Success signalling** – Add assertion coverage for Settings success notifications (currently manual per FUNCTION_LOG.md).

## Reference Map
- Store suites: `apps/mobile/src/store/__tests__/`
- Hook suites: `apps/mobile/src/hooks/__tests__/`
- Component & screen suites: `apps/mobile/src/components/__tests__/`, `apps/mobile/src/screens/__tests__/`
- Performance suite: `apps/mobile/src/__tests__/performance/store-performance.test.ts`
- Coverage configuration: `apps/mobile/jest.config.js`
- CI workflow: `.github/workflows/test-mobile.yml`

By keeping these artefacts current and expanding Detox plus cross-app parity, the testing program will fully satisfy Phase 3 commitments and provide a sustainable foundation for future releases.
