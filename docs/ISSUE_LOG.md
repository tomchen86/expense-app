# Issue Log

_Last updated: July 15, 2026_

## Purpose

Track bugs, feature proposals, and technical chores without relying on GitHub Issues. This log captures the intent, status, and next action for each item so a solo developer (and AI collaborators) can stay aligned.

## How to Use

1. Use `pnpm workflow issue add` to create an issue in the structured source.
2. Use `pnpm workflow issue update` to change status, priority, notes, or other fields.
3. Use `pnpm workflow issue close` to record completion evidence and a date.
4. Use `pnpm workflow issue render` after an authorized source change.
5. Use `pnpm workflow issue validate` to prove this view matches the source.
6. Link requirements and durable references instead of duplicating their content.

## Status Legend

- `📋 Proposed`
- `🚧 In Progress`
- `✅ Done`
- `❌ Blocked`
- `🕒 Icebox`

## Priority Buckets

- `Now`: Should be worked immediately
- `Next`: On deck once current tasks finish
- `Later`: Nice-to-have or future phase

## Feature Proposals

| ID | Title | Status | Priority | Requirement | References | Notes / Next Steps |
| --- | --- | --- | --- | --- | --- | --- |
| ISS-001 | Dual persistence toggle UX | 📋 | Next | — | `docs/architecture/STORAGE_STRATEGY.md`, `docs/archive/legacy/planning/PLAN-TASK_2.3_AUTH_INTEGRATION.md` | No persistence provider contract exists yet. Define storage-mode semantics only after the provider and authentication boundaries are specified. |
| ISS-002 | Expense discovery controls | 📋 | Now | [Expense ledger](../openspec/specs/expense-ledger/spec.md) | `docs/archive/legacy/planning/ROADMAP.md#phase-3` | The API supports search and filters, but the mobile list has no keyword search, date-range filter, or user-selectable sort controls. |
| ISS-003 | Activate workflow-assurance branch rules | ❌ | Now | [Workflow assurance](../openspec/changes/establish-executable-ai-workflow/specs/workflow-assurance/spec.md) | `.github/workflows/workflow-assurance.yml`, `.github/CODEOWNERS` | After the workflow exists on the remote default branch, require workflow-assurance, an up-to-date base, code-owner approval with stale dismissal, and no bypass. Remote inspection is currently blocked by invalid GitHub authentication. |

## Bugs & Regressions

| ID | Title | Status | Priority | Requirement | References | Notes / Next Steps |
| --- | --- | --- | --- | --- | --- | --- |
| ISS-101 | Group name validation lacks inline feedback | 📋 | Now | [Group collaboration](../openspec/specs/group-collaboration/spec.md) | `docs/Testing/PHASE3_TESTING_REPORT.md` | TextInputModal reports an empty group name through a global alert rather than inline field feedback and focus handling. |
| ISS-102 | Post-migration tests still rely on sqlite entity mirrors | 🕒 | Later | — | `apps/api/src/entities/*simple.entity.ts` | Decide whether to remove mirrors after Postgres-first testing lands. |
| ISS-104 | Category swipe-to-delete shows red background but no "Delete" text | 📋 | Now | — | `apps/mobile/src/components/categories/CategoryListItem.tsx` | Swipeable delete action displays red color but text not visible. Check Reanimated interpolate transform. |
| ISS-105 | Deleted categories still appear in Add Expense form | 📋 | Now | — | `apps/mobile/src/hooks/useExpenseForm.ts` | Reopened: useExpenseForm reads the category store, but useExpenseModals still builds its selector from DEFAULT_CATEGORIES, so deleted or custom categories can drift. |
| ISS-106 | Create navigation integration tests using renderRouter | 📋 | Next | — | `docs/features/testing/EXPO_ROUTER_TESTING_ANALYSIS.md` | Add integration tests for: Home→AddExpense flow, expense editing with params, group detail navigation, tab navigation. Use `renderRouter` from expo-router/testing-library. |
| ISS-107 | Expense category selector bypasses category store | 📋 | Now | [Category management](../openspec/specs/category-management/spec.md) | `apps/mobile/src/hooks/useExpenseModals.ts`, `apps/mobile/src/hooks/useExpenseForm.ts` | Build modal options from current store categories so add/edit flows reflect custom and deleted categories. |
| ISS-108 | Group balances ignore splitBetween selections | 📋 | Now | [Group collaboration](../openspec/specs/group-collaboration/spec.md) | `apps/mobile/src/utils/groupCalculations.ts`, `apps/mobile/src/hooks/useExpenseForm.ts` | The form stores participant IDs in splitBetween, while balance calculation reads expense.participants and can divide across the wrong members. |
| ISS-109 | Group mutations do not enforce owner role | 📋 | Now | [Group collaboration](../openspec/specs/group-collaboration/spec.md) | `apps/api/src/services/group.service.ts`, `apps/mobile/app/(tabs)/history.tsx` | Membership roles are stored, but update/delete operations authorize by ledger membership rather than requiring the group owner. |
| ISS-110 | API can delete default categories | 📋 | Next | [Category management](../openspec/specs/category-management/spec.md) | `apps/api/src/services/category.service.ts` | The API blocks deletion of categories in use but does not reject deletion when isDefault is true; align server protection with the reserved mobile category rule. |
| ISS-111 | API authentication accepts fallback JWT secrets | 📋 | Now | [Identity and access](../openspec/specs/identity-and-access/spec.md) | `apps/api/src/modules/auth.module.ts`, `apps/api/src/services/auth.service.ts`, `apps/api/src/guards/jwt-auth.guard.ts` | Production-capable code falls back to known development access and refresh secrets; startup must fail closed outside an explicit local test mode. |
| ISS-112 | Mobile domain state is not persisted | 📋 | Now | — | `apps/mobile/src/store/composedExpenseStore.ts`, `apps/mobile/src/store/features/userStore.ts` | Zustand stores use subscribeWithSelector without persist middleware or an AsyncStorage adapter, so expenses, groups, categories, and identity reset with process state. |
| ISS-113 | Mobile can delete categories that are in use | 📋 | Next | [Category management](../openspec/specs/category-management/spec.md) | `apps/mobile/src/hooks/useCategoryManager.ts`, `apps/api/src/services/category.service.ts` | The mobile flow warns and then deletes; the API already rejects CATEGORY_IN_USE. Align local behavior before synchronization. |

## Enhancements & Tech Debt

| ID | Title | Status | Priority | Requirement | References | Notes / Next Steps |
| --- | --- | --- | --- | --- | --- | --- |
| ISS-201 | Persistence provider contract package | 📋 | Next | [Persistence and sync gap](../openspec/changes/establish-executable-ai-workflow/requirement-audit.md) | `docs/architecture/STORAGE_STRATEGY.md`, `docs/archive/legacy/planning/PLAN-PHASE_2_API_DEVELOPMENT.md` | Extract interfaces + adapters into shared library before mobile rollout. |
| ISS-202 | API conflict resolution telemetry | 🕒 | Later | — | `docs/architecture/STORAGE_STRATEGY.md#sync--conflict-handling` | Add logging/metrics for queue failures once sync exists. |
| ISS-203 | Integrate mobile with authenticated API contracts | 📋 | Now | [API platform](../openspec/specs/api-platform/spec.md) | `apps/api/src/controllers`, `apps/mobile/src/store` | Core API endpoints exist; define token handling, identifier mapping, response adapters, offline behavior, and migration from in-memory mobile stores. |
| ISS-204 | Define shared domain and money mapping | 📋 | Now | — | `apps/mobile/src/types/index.ts`, `apps/api/src/dto/expense.dto.ts` | Reconcile mobile amount/title/name fields with API amountCents/description/UUID contracts before integration; do not share persistence entities directly. |
| ISS-205 | Recover the web application source boundary | ❌ | Later | — | `apps/web`, `.gitmodules` | apps/web is a gitlink but the repository has no .gitmodules declaration and the checkout contains no source, so web requirements cannot be verified. |
| ISS-206 | Add refresh-token revocation lifecycle | 📋 | Next | [Identity and access](../openspec/specs/identity-and-access/spec.md) | `apps/api/src/services/auth.service.ts` | Refresh tokens are signed but not backed by a revocable server-side session or token-family record. |
| ISS-207 | Create TESTING_OVERVIEW.md as single source of truth | ✅ | Next | — | `docs/features/testing/TESTING_OVERVIEW.md` | Completed: Created comprehensive testing overview with coverage summary, framework details, and links to all test docs. |
| ISS-208 | Migrate API tests from Jest to Vitest | 🕒 | Later | — | `apps/api/` | Migrate 142 API tests to Vitest for native ESM support and faster execution. Update config, setup files, and test syntax. |
| ISS-209 | Migrate Web tests from Jest to Vitest | 🕒 | Later | — | `apps/web/` | Migrate web tests to Vitest. Keep mobile on Jest (React Native ecosystem requirement). |
| ISS-210 | Define production API observability baseline | 📋 | Later | — | `apps/api/src`, `docs/archive/legacy/planning/ROADMAP.md` | Define health signals, structured logging, metrics, alert ownership, and deployment targets after a production API environment exists. |

## Archive

| ID | Title | Requirement | Completion Notes | Date |
| --- | --- | --- | --- | --- |
| ISS-103 | Tab bar navigation wrong order after Expo Router migration | — | Repository audit confirmed the intended tab order in apps/mobile/app/(tabs)/_layout.tsx. | 2026-07-15 |
