# Update Checklist

_Last updated: September 26, 2025_

## Purpose

Follow this checklist at the end of every coding session or before committing. Each step calls out when it applies so you can keep momentum without running unnecessary commands.

## Session Flow

1. Snapshot the workspace
2. Run quality gates for any areas you touched
3. Refresh documentation (always/triggered/never)
4. Final git + release readiness
5. Spot-check optional items when the work warrants it

---

## 1. Workspace Snapshot (Always)

- `git status` — confirm staged vs. unstaged changes
- `git diff` & `git diff --staged` — skim for unintentional edits or secrets
- `pnpm install --frozen-lockfile` — only if `package.json`, `pnpm-lock.yaml`, or workspace deps changed

---

## 2. Quality Gates (Run Per Touched Surface)

| Surface                | Run When                                                | Commands                                                                                       | Notes                                                                                                                               |
| ---------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Mobile (`apps/mobile`) | Any mobile code, store, or hooks touched                | `pnpm --filter mobile lint`<br>`pnpm --filter mobile typecheck`<br>`pnpm --filter mobile test` | Add `pnpm --filter mobile test:e2e` when flows change; do a device/simulator smoke test for major UI moves.                         |
| API (`apps/api`)       | Backend services, entities, DTOs, migrations touched    | `pnpm --filter api lint`<br>`pnpm --filter api build` (typecheck)<br>`pnpm --filter api test`  | Add `pnpm --filter api test:e2e` when routes/auth/database logic changes. Run pending migrations against test DB if schema updated. |
| Web (`apps/web`)       | Frontend components/routes/shared web utilities touched | `pnpm --filter web lint`<br>`pnpm --filter web typecheck`<br>`pnpm --filter web test`          | Run `pnpm --filter web build` when touching routing/config/build output. Spot-check responsive states for UI work.                  |
| Monorepo shared code   | Packages, configs, tooling, git hooks touched           | `pnpm lint --recursive`<br>`pnpm test --recursive` (if shared logic added)                     | Ensure Husky/pre-commit scripts still pass locally.                                                                                 |

---

## 3. Documentation Pass

### Always Update

- `docs/FUNCTION_LOG.md` — adjust requirement statuses, tests, and priority buckets you touched.
- `docs/CHANGELOG.md` — add one-line entries linking to detailed logs or PRs.
- `docs/CURRENT_STATUS_AND_NEXT_STEPS.md` — note delivered work, outstanding verification (e.g., tests that must rerun outside sandbox), and the next milestone focus.

### Conditional Updates (apply when the trigger happened)

| Document                                                                        | Trigger                                     | Quick Action                                            |
| ------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------- |
| `docs/SESSION_SUMMARY_[YYYY-MM-DD].md`                                          | You made strategic decisions or discoveries | Jot key insights, blockers, or next bets.               |
| `docs/TASK_[N].[N]_COMPLETION_LOG.md`                                           | You worked on a tracked task                | Log progress, subtasks finished, references to commits. |
| `AGENTS.md`                                                                     | Contributor expectations changed            | Capture new guardrails or process updates.              |
| `docs/Testing/TESTING_STRATEGY.md` / `docs/Testing/TESTING_IMPROVEMENT_PLAN.md` | Testing approach or coverage goals changed  | Update scenarios, coverage targets, or new gaps.        |
| `docs/ARCHITECTURE.md` / `docs/ARCHITECTURE_DECISION_RECORDS.md`                | Architecture or platform decision made      | Record decision, rationale, and impact.                 |
| `docs/RISK_ASSESSMENT.md`                                                       | New risks discovered or mitigated           | Add entry with status/mitigation.                       |
| `docs/planning/ROADMAP.md` & `docs/planning/PHASE_*`                            | Phase scope adjusted                        | Update milestones or archive completed plans.           |
| `.env.example` / deployment docs                                                | Environment or deployment variables changed | Keep onboarding accurate.                               |

### Never Modify (Protect History)

- Archived plans (`docs/archive/`)
- Original task plans (`TASK_[N].[N]_..._PLAN.md`)
- Closed ADRs and past session summaries

Refer to `docs/DOCUMENT_STRUCTURE_GUIDE.md` for fuller document ownership details.

---

## 4. Git & Release Readiness

- Ensure staging area only contains intended files (`git add -p` can help).
- Verify no secrets, API keys, or large binaries slipped into commits.
- Write a concise, imperative commit message that matches project conventions.
- Squash or tidy branches before sharing if the history is noisy.
- If ready for review, push to the remote and note next steps in the relevant planning doc.

---

## 5. Situational Checks (Run When Relevant)

- `pnpm --filter mobile expo start --clear` — only when Expo cache issues block testing.
- `pnpm --filter api test:load` (or Artillery/k6 scripts) — for performance-sensitive backend changes.
- `pnpm --filter web test:e2e` or Playwright runs — when you changed web journeys.
- Accessibility audit (axe, Lighthouse) — on significant UI or component library updates.
- Manual device testing (iOS/Android) — before cutting a release candidate.

---

## Quick Command Reference

```bash
# Lint / type / test per workspace
pnpm --filter mobile lint
pnpm --filter mobile typecheck
pnpm --filter mobile test
pnpm --filter api lint
pnpm --filter api build
pnpm --filter api test
pnpm --filter web lint
pnpm --filter web typecheck
pnpm --filter web test

# Monorepo sweeps
git status
git diff --staged
pnpm lint --recursive
pnpm install # ensure workspace deps are synced after removing npm artifacts
```

Keep this checklist lean—update it alongside `docs/DOCUMENT_STRUCTURE_GUIDE.md` whenever workflows change.
