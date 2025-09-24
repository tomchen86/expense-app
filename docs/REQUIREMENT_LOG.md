# Function Log

_Last updated: September 23, 2025_

## How to Use

- Treat this as the single backlog: every requirement lives here with its current status, priority, and test touchpoints.
- Keep each row concise—one requirement per line—linking to deeper docs instead of duplicating details.
- Update the status and priority immediately after working on an item; note the highest-level tests that cover it.
- When you spin up a new requirement, add it to the appropriate table with a quick Next/Notes entry so you remember the follow-up.
- If a requirement originated in `docs/ISSUE_LOG.md`, reference the issue ID in the Notes column (e.g., `Origin: ISS-002`) and archive the issue once shipped.

## Status Legend

`✅ Implemented` finished and validated by listed tests
`🚧 In progress` actively being built
`🔄 Needs polish` functionally there but missing UX/coverage cleanup
`📋 Planned` captured in the backlog but no active work
`❌ Blocked` cannot proceed until a dependency lands

## Priority Buckets

`Now` currently on your plate or urgent
`Next` queued once Now items close
`Later` nice-to-have or future phase

## Backlog Snapshot

- **Now**: expand expense filtering/search, refine group name UX, expand category colors, finish API schema draft, testing coverage improvements (see docs/Testing/TESTING_IMPROVEMENT_PLAN.md).
- **Next**: group permission rules, unique user identifier, persistence provider contract rollout, API endpoints.
- **Blocked**: mobile ↔ API integration (waiting on core endpoints), monitoring rollout (needs production API).

## Requirement Catalogue

### Mobile App (`apps/mobile`)

#### Navigation & Layout

| Requirement                                           | Status | Priority | Tests     | Next / Notes                                      |
| ----------------------------------------------------- | ------ | -------- | --------- | ------------------------------------------------- |
| Bottom tab navigation (`Home`, `History`, `Settings`) | ✅     | Later    | Unit, E2E | No further action.                                |
| Floating "Add Expense" button across primary screens  | ✅     | Later    | E2E       | Watch for layout regressions once web view added. |
| Modal stack for add/edit flows                        | ✅     | Later    | Unit      | Confirm behavior once deep links exist.           |

#### Expense Capture & List

| Requirement                                                        | Status | Priority | Tests             | Next / Notes                                                                                |
| ------------------------------------------------------------------ | ------ | -------- | ----------------- | ------------------------------------------------------------------------------------------- |
| Add/edit expense requires title, amount, category via bottom sheet | ✅     | Later    | Unit, Integration | Maintain parity with API once wired.                                                        |
| Optional caption and group assignment                              | ✅     | Later    | Unit              | Ensure captions sync when cloud mode lands.                                                 |
| Amount validation with decimal + currency formatting               | ✅     | Later    | Unit              | Consider locale formatting under API sync.                                                  |
| Date picker available in entry flow                                | ✅     | Later    | Unit              | Prep to handle API-provided dates.                                                          |
| Expense list shows color-coded categories and group tags           | ✅     | Later    | Unit              | Revisit once web shares store.                                                              |
| Tap to edit & swipe to delete expenses                             | ✅     | Later    | Unit, E2E         | Keep Detox regression tests current.                                                        |
| Group expenses show badge in list                                  | ✅     | Later    | Unit              | Covered via store tests.                                                                    |
| Date range filtering                                               | ✅     | Now      | Unit              | Expand to keyword search (see below).                                                       |
| Keyword search for expenses                                        | 📋     | Now      | —                 | Origin: ISS-002. Add search field + store selector; link: docs/planning/ROADMAP.md#phase-3. |
| Expense sorting (date, amount, category)                           | 📋     | Next     | —                 | Keep design simple (three toggles).                                                         |

#### Insights & Analytics

| Requirement                                          | Status | Priority | Tests | Next / Notes                               |
| ---------------------------------------------------- | ------ | -------- | ----- | ------------------------------------------ |
| "Total Share" opens insights hub                     | ✅     | Later    | E2E   | Covered in Detox.                          |
| Monthly/yearly insights with pie + totals            | ✅     | Later    | Unit  | Validate against API totals later.         |
| Time controls (arrows + picker + swipe gesture)      | ✅     | Later    | E2E   | Monitor gesture conflicts after web embed. |
| Group insights mirror individual view incl. balances | ✅     | Later    | Unit  | Reconcile with backend split logic.        |

#### Categories

| Requirement                                          | Status | Priority | Tests     | Next / Notes                                                                  |
| ---------------------------------------------------- | ------ | -------- | --------- | ----------------------------------------------------------------------------- |
| Manage categories screen: list/add/edit/swipe delete | ✅     | Later    | Unit, E2E | Ensure API sync keeps optimistic updates.                                     |
| Color picker for categories                          | ✅     | Now      | Unit      | Expand palette; capture decision in docs/Testing/TESTING_IMPROVEMENT_PLAN.md. |
| Guard default "Other" from deletion                  | ✅     | Later    | Unit      | Add API parity later.                                                         |
| Prevent deleting categories still in use             | 📋     | Next     | —         | Requires usage check in store + API future.                                   |

#### Groups

| Requirement                                          | Status | Priority | Tests     | Next / Notes                                                                                       |
| ---------------------------------------------------- | ------ | -------- | --------- | -------------------------------------------------------------------------------------------------- |
| Create group (requires username) via modal flow      | ✅     | Later    | Unit, E2E | Add API-backed creation later.                                                                     |
| Group list shows totals, contributions, expense feed | ✅     | Later    | Unit      | Align data model with backend schema.                                                              |
| Group insights accessible from totals view           | ✅     | Later    | Unit      | Compare outputs with API once available.                                                           |
| "My Total Contribution" shows participant balances   | ✅     | Later    | Unit      | Keep an eye on rounding with API data.                                                             |
| Group name validation UX (alert styling)             | 🔄     | Now      | Manual    | Origin: ISS-101. Improve modal feedback; reference docs/Testing/PHASE3_TESTING_REPORT.md findings. |
| Restrict delete to creator; allow leaving group      | 📋     | Next     | —         | Needs role metadata; depends on unique IDs.                                                        |
| Preserve group tags after member leaves              | 📋     | Next     | —         | Requires store history strategy.                                                                   |

#### Settings & Identity

| Requirement                               | Status | Priority | Tests     | Next / Notes                                                             |
| ----------------------------------------- | ------ | -------- | --------- | ------------------------------------------------------------------------ |
| Persist username (display name)           | ✅     | Later    | Unit, E2E | No further action until API.                                             |
| Manage Categories entry in settings       | ✅     | Later    | E2E       | Ensure nav persists after refactor.                                      |
| Success notification styling after saving | 🔄     | Now      | Manual    | Use shared toaster once web/mobile align.                                |
| Introduce stable unique user identifier   | 📋     | Next     | —         | Depends on API auth; see docs/planning/TASK_2.1_DATABASE_DESIGN_PLAN.md. |

#### Data & Sync

| Requirement                                                                 | Status | Priority | Tests | Next / Notes                                                                            |
| --------------------------------------------------------------------------- | ------ | -------- | ----- | --------------------------------------------------------------------------------------- |
| Local persistence with Zustand + AsyncStorage                               | ✅     | Later    | Unit  | Keep store-performance.test.ts updated.                                                 |
| Pluggable persistence provider architecture (AsyncStorage → SQLite → Cloud) | 📋     | Next     | —     | Origin: ISS-201. Align with `docs/Storage_Strategy.md`; depends on Task 2.2 groundwork. |
| Cloud sync with API backend                                                 | 📋     | Next     | —     | Follows provider contract + auth; see `docs/planning/PHASE_2_API_DEVELOPMENT_PLAN.md`.  |
| User selectable storage mode (local vs cloud)                               | 📋     | Later    | —     | Guided upgrade/downgrade flows defined in `docs/Storage_Strategy.md`.                   |

### API (`apps/api`)

| Requirement                                        | Status | Priority | Tests                            | Next / Notes                                                                                  |
| -------------------------------------------------- | ------ | -------- | -------------------------------- | --------------------------------------------------------------------------------------------- |
| NestJS bootstrap + lint/format tooling             | ✅     | Later    | —                                | Baseline done.                                                                                |
| PostgreSQL schema design (users, groups, expenses) | 🚧     | Now      | —                                | See docs/planning/TASK_2.1_DATABASE_DESIGN_PLAN.md for work-in-progress.                      |
| TypeORM entities + migrations                      | 🚧     | Now      | `pnpm --filter api test`         | Identity stack in place for users/settings/auth/devices; expand to collaboration tables next. |
| Seed scripts for default data                      | 🚧     | Next     | `pnpm --filter api test -- seed` | Default user settings seed landed; extend with categories after ledger schema.                |
| Authentication (register, login, tokens)           | 📋     | Next     | —                                | Align with mobile unique ID requirement.                                                      |
| Expense CRUD endpoints                             | 📋     | Next     | —                                | Blocker for mobile integration.                                                               |
| Group management endpoints                         | 📋     | Later    | —                                | Build after auth.                                                                             |
| Category endpoints (CRUD + defaults)               | 📋     | Later    | —                                | Reuse seed logic.                                                                             |
| Mobile ↔ API integration                          | ❌     | Blocked  | —                                | Depends on auth + expense endpoints.                                                          |

### Web App (`apps/web`)

| Requirement                                 | Status | Priority | Tests | Next / Notes                 |
| ------------------------------------------- | ------ | -------- | ----- | ---------------------------- |
| App Router + TS + Tailwind baseline         | ✅     | Later    | —     | No action.                   |
| Authentication pages (login/register/reset) | 📋     | Later    | —     | Phase 4 roadmap.             |
| Expense dashboard with analytics widgets    | 📋     | Later    | —     | Derive from mobile insights. |
| Export functionality (PDF/CSV)              | 📋     | Later    | —     | Consider third-party libs.   |

### Cross-Cutting Requirements

| Requirement                                           | Status | Priority | Tests | Next / Notes                                                |
| ----------------------------------------------------- | ------ | -------- | ----- | ----------------------------------------------------------- |
| Shared domain types for expense/group/user            | 📋     | Next     | —     | Coordinate with docs/ARCHITECTURE.md guidance.              |
| Map requirements to automated tests as coverage grows | 🔄     | Now      | —     | Track progress in docs/Testing/TESTING_IMPROVEMENT_PLAN.md. |
| Production monitoring & alerting plan                 | 📋     | Later    | —     | Needs deployed API.                                         |

## Linked References

- `docs/planning/ROADMAP.md` — phase timelines and milestones.
- `docs/planning/TASK_2.1_DATABASE_DESIGN_PLAN.md` — API/database WIP.
- `docs/Testing/TESTING_STRATEGY.md` & `docs/Testing/TESTING_IMPROVEMENT_PLAN.md` — detailed testing intentions and gaps.
- `docs/Testing/PHASE3_TESTING_REPORT.md` — latest coverage findings.

## Maintenance Notes

- Review this log at the start/end of each session to bump dates, statuses, and priority buckets.
- When closing a requirement, ensure relevant tests exist and are noted; otherwise flag it as `🔄 Needs polish`.
- Prune stale notes and add blockers as they emerge so the backlog stays trustworthy.
