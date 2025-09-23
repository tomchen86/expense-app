# Issue Log

_Last updated: September 23, 2025_

## Purpose
Track bugs, feature proposals, and technical chores without relying on GitHub Issues. This log captures the intent, status, and next action for each item so a solo developer (and AI collaborators) can stay aligned.

## How to Use
1. **Create an entry** under the relevant section (Feature, Bug, Enhancement) with a short identifier (`ISS-###`).
2. **Update the status** (`📋 Proposed`, `🚧 In Progress`, `✅ Done`, `❌ Blocked`, `🕒 Icebox`) and priority bucket (`Now`, `Next`, `Later`).
3. **When you commit to deliver an issue**, add the matching requirement row to `docs/REQUIREMENT_LOG.md` and capture the requirement anchor (e.g., `docs/REQUIREMENT_LOG.md#expense-capture--list`) in the `Requirement` column.
4. **Link supporting docs** (roadmap tasks, ADRs, testing plans) in the References column instead of duplicating details.
5. **Move closed items** to the Archive section at the bottom once the requirement ships and both files show the final status.
6. **Review weekly** when grooming `REQUIREMENT_LOG.md` so the backlog stays consistent.

## Status Legend
- `📋 Proposed`: Captured idea, not yet scheduled
- `🚧 In Progress`: Actively being worked
- `✅ Done`: Implemented and validated
- `❌ Blocked`: Waiting on dependency or decision
- `🕒 Icebox`: Intentionally deferred

## Priority Buckets
- `Now`: Should be worked immediately
- `Next`: On deck once current tasks finish
- `Later`: Nice-to-have or future phase

## Feature Proposals
| ID | Title | Status | Priority | Requirement | References | Notes / Next Steps |
|----|-------|--------|----------|-------------|------------|--------------------|
| ISS-001 | Dual persistence toggle UX | 📋 | Next | — | `docs/Storage_Strategy.md`, `docs/planning/TASK_2.3_AUTH_INTEGRATION_PLAN.md` | Design settings UI copy and confirmation dialogs for switching modes. |
| ISS-002 | Expense keyword search | 🚧 | Now | [Req: Expense capture & list](docs/REQUIREMENT_LOG.md#expense-capture--list) | `docs/planning/ROADMAP.md#phase-3` | Implement selector + UI field per current backlog. |

## Bugs & Regressions
| ID | Title | Status | Priority | Requirement | References | Notes / Next Steps |
|----|-------|--------|----------|-------------|------------|--------------------|
| ISS-101 | Group name validation lacks inline feedback | 🚧 | Now | [Req: Groups](docs/REQUIREMENT_LOG.md#groups) | `docs/Testing/PHASE3_TESTING_REPORT.md` | Replace alert with inline error + focus handling. |
| ISS-102 | Post-migration tests still rely on sqlite entity mirrors | 🕒 | Later | — | `apps/api/src/entities/*simple.entity.ts` | Decide whether to remove mirrors after Postgres-first testing lands. |

## Enhancements & Tech Debt
| ID | Title | Status | Priority | Requirement | References | Notes / Next Steps |
|----|-------|--------|----------|-------------|------------|--------------------|
| ISS-201 | Persistence provider contract package | 📋 | Next | [Req: Data & Sync](docs/REQUIREMENT_LOG.md#data--sync) | `docs/Storage_Strategy.md`, `docs/planning/PHASE_2_API_DEVELOPMENT_PLAN.md` | Extract interfaces + adapters into shared library before mobile rollout. |
| ISS-202 | API conflict resolution telemetry | 📋 | Later | — | `docs/Storage_Strategy.md#sync--conflict-handling` | Add logging/metrics for queue failures once sync exists. |

## Archive
(Move closed issues here with completion notes and the requirement link.)

| ID | Title | Requirement | Completion Notes | Date |
|----|-------|-------------|------------------|------|
