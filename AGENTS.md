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
