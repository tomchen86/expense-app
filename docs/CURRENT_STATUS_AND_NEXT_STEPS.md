# API Status & Next Actions (September 2025)

## Current State

- **Authentication & User Settings**: `/auth` and `/api/users` endpoints aligned with mobile contracts, persistence mode toggle + device registry live.
- **Collaboration Layer**: Categories, participants, and groups now share the `LedgerService` bootstrap; integration suites cover mobile-style responses and latency.
- **Database & Docs**: Migrations and schema definitions are stable (`docs/DATABASE_SCHEMA.md`, `docs/STORAGE_STRATEGY.md`). Strategic plans updated (`docs/planning/NEXT_STEPS_STRATEGIC_PLAN.md`).
- **Expense Engine**: Expense service/controller landed with CRUD, split validation, and statistics endpoints; integration suite exists but needs a rerun outside the sandbox to confirm (`apps/api/src/__tests__/api/integration/expense-mobile-compat.spec.ts`).

## Immediate Next Steps

1. **Expense Engine Verification & Hardening**
   - Re-run expense integration suite in an unrestricted shell; add coverage for statistics edge cases and receipt uploads once verified.
   - Reference: `apps/api/src/__tests__/api/integration/expense-mobile-compat.spec.ts`, `docs/TDD_API_IMPLEMENTATION_PLAN.md` (Phase 4).
2. **Conflict Handling & Sync Contracts**
   - Design optimistic concurrency for expenses, return conflict payloads the mobile client can reconcile.
   - Reference: `docs/STORAGE_STRATEGY.md`, `docs/ARCHITECTURE.md` (participant & group models).
3. **Data Migration API**
   - Build local → cloud import/export endpoints, mapping mobile IDs to server UUIDs.
   - Reference: `docs/planning/NEXT_STEPS_STRATEGIC_PLAN.md`, `docs/SESSION_SUMMARY_2025_09_25.md`.

## Relevant References for Agents

- **Strategic Plans**: `docs/planning/NEXT_STEPS_STRATEGIC_PLAN.md`, `docs/planning/PHASE_2_API_DEVELOPMENT_PLAN.md`, `docs/TDD_API_IMPLEMENTATION_PLAN.md`, `docs/planning/TASK_2.2_API_ENDPOINTS_PLAN.md`.
- **Schema & Storage**: `docs/DATABASE_SCHEMA.md`, `docs/STORAGE_STRATEGY.md`.
- **Architecture**: `docs/ARCHITECTURE.md`, `docs/API_IMPLEMENTATION_DETAILS.md`.
- **Testing**: `docs/Testing/API_TEST_COMPREHENSIVE_SUMMARY.md`, `docs/Testing/TESTING_STRATEGY.md`.
- **Operating Norms**: `AGENTS.md` for contributor guardrails (retain shared docs unless product owner approves removal), `docs/CHANGELOG.md` for milestone history.

Use these documents before modifying or planning API features; they capture the agreed contracts, TDD path, and cross-agent expectations.

## Update Discipline & Coordination

- Refresh the "Immediate Next Steps" section after each milestone and echo the change in `docs/CHANGELOG.md`.
- Cross-link any new specs or diagrams from this file so agents land on the latest sources of truth.
- Surface blockers in `docs/ISSUE_LOG.md` and mention them in daily summaries to keep the plan actionable.
- Record any out-of-band test runs (including commands and environment notes) so future agents can reproduce results quickly.
