# Current and Next Steps

## Snapshot

- Last verified: 2026-07-14 (Australia/Melbourne)
- Baseline commit: `e82bf098f323beb57005efda4dcb943ccdd58f24`
- Active change: `establish-executable-ai-workflow`
- Active task: `2.1` — allowlisted checks and disposable database policy
- Last completed tasks: `1.1`–`1.3` under the documented one-time bootstrap
  exception
- Bootstrap implementation commit: pending
- Active workflow session: none
- Verification: workflow typecheck, lint, 9/9 tests, and change validation pass

## Current System Picture

- Product architecture: `docs/architecture/ARCHITECTURE.md`
- Storage architecture: `docs/architecture/STORAGE_STRATEGY.md`
- API reference: `docs/features/api/GUIDE-API_CODE.md`
- Test reference: `docs/features/testing/TESTING_OVERVIEW.md`
- Historical planning and status files conflict and require a fresh code-backed
  audit before their product progress claims are reused.

## In Progress

The repository is being moved from prompt-led workflow guidance to a split
model:

- OpenSpec files own requirements, proposal, design, delta specs, and tasks.
- `guard.json` owns per-task path and check policy.
- The repository workflow engine owns runtime Git facts, sessions, evidence,
  and authorization.
- Spectra remains installed but is not used.

## Blockers and Decisions Needed

- The current worktree contains pre-existing untracked directories and planning
  documents. The strict session-start guard must reject this state; it must not
  delete, stash, or absorb those files automatically.
- Product roadmap facts from 2025/early 2026 have not yet been reconciled with
  the current code and test suite.

## Just Completed

- Chose a single change/task source: `openspec/changes/<change-id>/`.
- Chose an independent execution-assurance engine instead of a second planning
  framework.
- Chose explicit Spectra non-participation while retaining its installation.
- Added `doctor`, `validate-change`, `start`, `status`, `check`, and `abort`
  commands with stable guard errors and JSON output.
- Added clean-baseline, protected/exact branch, exclusive lock, artifact digest,
  segment-aware path scope, and session-policy tamper checks.
- Verified the real repository is rejected on protected `main` without creating
  runtime state; disposable Git integration tests cover the valid path.

## Next Steps

1. Implement allowlisted check execution using fixed argv arrays.
2. Require and validate an explicitly disposable `TEST_DATABASE_URL` before
   destructive API checks.
3. Add immutable reports and evidence-authorized `complete-task`.
4. Begin the structured issue/Document Gateway migration only after the
   completion boundary is tested.
