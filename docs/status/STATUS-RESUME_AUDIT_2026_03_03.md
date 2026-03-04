# Resume Audit - March 3, 2026

## Purpose

This document reconciles project status after a pause and provides a clean restart checklist for human/AI contributors.

## Verified Snapshot (2026-03-03)

### Git state

- Local branch: `main`
- Local vs remote: `main` is ahead of `origin/main` by 18 commits, behind by 0.
- Working tree is not clean (active in-progress changes exist in mobile and docs).

### Build/Test smoke results run during this audit

| Command                                                                                                              | Result                   | Notes                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter api build`                                                                                            | PASS                     | Nest build succeeds.                                                                                                            |
| `pnpm --filter mobile typecheck`                                                                                     | FAIL                     | `apps/mobile/src/components/DatePicker.tsx`: `Cannot find name 'testID'` (TS2552).                                              |
| `pnpm test --runInBand --watchman=false src/hooks/__tests__/useExpenseForm-category-sync.int.tsx` (in `apps/mobile`) | PASS                     | 7/7 tests passed.                                                                                                               |
| `pnpm exec jest --runInBand --watchman=false src/__tests__/database/connection.spec.ts` (in `apps/api`)              | PASS                     | 5/5 tests passed.                                                                                                               |
| Full API suite (`pnpm test --runInBand` in `apps/api`)                                                               | FAIL in this environment | Many specs fail with `listen EPERM` / local port bind restrictions in sandbox. Not a reliable product-failure signal by itself. |

## Reconciled Status

### What is likely true

1. API codebase compiles (`api build` green).
2. Mobile currently has at least one real compile/type issue (`DatePicker.tsx` + `testID`).
3. At least one important mobile integration test still passes (`useExpenseForm-category-sync.int.tsx`).
4. API integration/e2e readiness cannot be fully validated from this sandbox due socket restrictions.

### Docs that are stale or conflicting

1. `docs/planning/ROADMAP.md` (last updated Sep 19, 2025) still describes API as an early gap.
2. `docs/status/STATUS-CURRENT_AND_NEXT_STEPS.md` and `docs/CHANGELOG.md` mark API as complete.
3. `CLAUDE.md` "Current Project Status" says API is in progress, which conflicts with changelog/status milestones.

## Canonical Read Order (for restart)

1. `docs/status/STATUS-RESUME_AUDIT_2026_03_03.md` (this file)
2. `docs/status/STATUS-E2E_IMPLEMENTATION.md` (mobile E2E pending work)
3. `docs/CHANGELOG.md` (milestone history)
4. `docs/GUIDE-LOG_TRACKING.md` (log boundaries/templates)

Use planning docs only after checking date and whether they predate API completion milestones.

## Start-From-Here Checklist

1. Cleanly resolve/commit/stash current working tree changes before new feature work.
2. Fix mobile type error in `apps/mobile/src/components/DatePicker.tsx` (`testID` symbol issue).
3. Re-run mobile gates:
   - `pnpm --filter mobile typecheck`
   - `pnpm --filter mobile test -- --runInBand --watchman=false src/hooks/__tests__/useExpenseForm-category-sync.int.tsx`
4. Re-run API gates in a non-sandbox/local environment with socket access:
   - `pnpm --filter api build`
   - `pnpm --filter api test -- --runInBand`
5. Reconfirm E2E baseline:
   - Build app for detox (`apps/mobile`) and run one smoke E2E spec.
6. Update `STATUS-E2E_IMPLEMENTATION.md` and `COMMIT_LOG.md` with actual rerun results.
7. Decide a single canonical status doc for "current truth" and mark other status summaries as historical snapshots.

## Notes for Future Sessions

- When running Jest in constrained environments, set `--watchman=false`.
- Treat `listen EPERM` and localhost bind failures as environment blockers first, then rerun in a full local environment before concluding regressions.
