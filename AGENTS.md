# Repository Workflow

This repository uses OpenSpec artifacts as versioned planning data and a
repository-owned workflow engine for execution assurance.

- Normative requirements live in `openspec/specs/`.
- Proposals, designs, delta specs, and task lists live in
  `openspec/changes/<change-id>/`.
- `guard.json` inside each change contains machine policy only: task path scope
  and required check IDs.
- Runtime sessions, locks, reports, Git validation, and completion authority
  belong to the executable workflow engine, not to Markdown or an AI prompt.
- `docs/ROADMAP.md` owns priority; `docs/CURRENT_AND_NEXT_STEPS.md` owns the
  current handoff.

Spectra files remain installed for compatibility and historical reference, but
agents must not invoke Spectra commands, skills, adapters, or lifecycle state.
Do not delete or rewrite the retained Spectra installation unless the
maintainer explicitly requests it.

During the workflow-engine bootstrap, use `pnpm workflow doctor` for diagnostics
and `pnpm workflow validate-change <change-id>` to validate tracked artifacts.
Only an executable workflow command may eventually authorize task checkbox,
completion, archive, staging, or commit transitions; never treat an AI claim as
evidence.

## Development Principle: Test-Driven Development

- Behavior changes and bug fixes follow RED → GREEN → REFACTOR.
- Before changing production behavior, add or identify a test that fails for
  the intended reason.
- Implement the smallest change that makes the test pass, then refactor while
  keeping the suite green.
- Documentation-only, formatting-only, dependency-only, and time-boxed research
  work may be exempt, but the reason must be stated.
- Database-writing API tests require an explicitly disposable
  `TEST_DATABASE_URL`; never use a development-database fallback.
- A task's configured checks and workflow report are the evidence; a checkbox
  or prose statement is not.

# Repository Guidelines

## Project Structure & Module Organization
- `apps/api/` – NestJS backend: controllers, services, modules, entities, and integration tests.
- `apps/mobile/` – React Native client with Zustand stores and Expo configuration for offline-first UX.
- `apps/web/` – Next.js web surface (currently secondary).
- `docs/` – Planning roadmaps, architecture notes, TDD plans, and testing strategy references.
- `apps/api/src/__tests__/` – Jest suites (`integration/`, `isolated/`, `migrations/`) aligned with RED→GREEN cycles.

## Build, Test, and Development Commands
```bash
pnpm install                       # bootstrap workspace dependencies
pnpm --filter api start:dev        # run NestJS API with live reload
pnpm --filter api build            # compile TypeScript, fail on type errors
pnpm --filter api test             # full API test suite
pnpm --filter api test -- <spec>   # targeted spec run, e.g. user-settings
pnpm prettier --check .            # formatting verification
```

API tests are destructive to their configured PostgreSQL database. Before any API test command, set `TEST_DATABASE_URL` to an explicitly disposable database whose contents may be truncated or dropped; never rely on the development-database fallback.

## Coding Style & Naming Conventions
- TypeScript everywhere; keep files under 500 LOC per docs.
- Filenames use kebab-case (e.g., `ledger.service.ts`). Controllers stay thin; services encapsulate business logic.
- Formatting via Prettier (`prettier.config.cjs`) and linting via ESLint (`eslint.config.mjs`). Do not bypass CI hooks.
- Never delete or rename repository files without explicit maintainer approval.

## Testing Guidelines
- Jest runner with supertest for integration specs; follow RED → GREEN → REFACTOR.
- Integration spec naming: `<feature>.spec.ts`; isolated/mocked: `<feature>.isolated.spec.ts`.
- Use `PerformanceAssertions.testEndpointPerformance` for mobile-critical endpoints to enforce latency budgets.
- Update docs/tests together; include fixtures in `apps/api/src/__tests__/helpers/` if new data shapes are required.

## Commit & Pull Request Guidelines
- Commit messages use imperative mood (“Add participant service”), scoped to a logical change set.
- PRs should:
  - Summarize intent and reference planning docs/issues.
  - List executed commands (`pnpm --filter api test -- ...`).
  - Attach screenshots/logs for UX or tooling adjustments.
  - Call out follow-up tasks, migrations, or env changes explicitly.

## Security & Configuration Tips
- Do not commit secrets; use environment variables defined in docs.
- For local dev, stash secrets in `.env.local` (ignored) and document required keys in the PR.
- Run `pnpm --filter api build` and targeted tests before pushing to avoid CI regressions.
