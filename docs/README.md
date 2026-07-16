# Expense App

Expense App is a monorepo for recording personal and shared expenses. The
product direction is an offline-first React Native experience backed by a
NestJS/PostgreSQL API, with clear contracts for authentication, groups,
categories, expenses, and insights.

## What Exists Today

The React Native mobile app implements the main local user flows for expenses,
groups, categories, and spending insights. Zustand stores coordinate the
current UI state, and Expo provides the mobile development environment.

The NestJS API contains modules for authentication, users, groups, categories,
expenses, and related persistence. PostgreSQL entities, migrations, validation,
and integration/isolated test suites establish the backend foundation.

`apps/web/` is currently an ordinary-directory placeholder. It is intentionally
tracked so a future web surface can be planned without relying on a Git
submodule, but the repository does not currently claim a working web app.

## Current Maturity

This is active development, not a production-ready system. The mobile and API
surfaces are not yet fully integrated, mobile domain state is not yet durable,
and the roadmap still tracks security, authorization, expense-split,
persistence, and contract-alignment gaps. Read the roadmap and generated
handoff before choosing the next implementation task.

## Monorepo Surfaces

- `apps/mobile/` — React Native/Expo client and Zustand domain stores.
- `apps/api/` — NestJS API, PostgreSQL persistence, migrations, and tests.
- `apps/web/` — tracked placeholder for a future web application.
- `packages/workflow-engine/` — repository-owned execution and assurance
  engine.
- `openspec/specs/` — normative current requirements.
- `openspec/changes/` — active proposals, designs, requirement deltas, tasks,
  and task guards.
- `docs/` — project, architecture, workflow, feature, issue, and historical
  knowledge.

## Getting Started

Install the pinned workspace dependencies from the repository root:

```bash
pnpm install
```

Common development commands:

```bash
pnpm --filter api start:dev
pnpm --filter api build
pnpm --filter api test
pnpm --filter api test -- <spec>
pnpm prettier --check .
```

API tests that write to PostgreSQL are destructive to the configured test
database. Set `TEST_DATABASE_URL` to an explicitly disposable database before
running them; never fall back to a development database.

Repository workflow diagnostics and managed-document validation are available
through:

```bash
pnpm workflow doctor --json
pnpm workflow documents validate --json
```

## Where to Read Next

- [`ROADMAP.md`](ROADMAP.md) — current priorities.
- [`CURRENT_AND_NEXT_STEPS.md`](CURRENT_AND_NEXT_STEPS.md) — generated handoff
  and next executable step.
- [`WORKFLOW.md`](WORKFLOW.md) — managed OpenSpec planning, task, commit,
  assurance, and archive lifecycle.
- [`architecture/`](architecture/) — current system-wide design references.
- [`features/`](features/) — implementation references grouped by feature.
- [`ISSUE_LOG.md`](ISSUE_LOG.md) — generated open-issue view.
- [`DOCUMENT_STRUCTURE_GUIDE.md`](DOCUMENT_STRUCTURE_GUIDE.md) — canonical
  document placement and mutation rules.
- [`../openspec/specs/`](../openspec/specs/) and
  [`../openspec/changes/`](../openspec/changes/) — normative behavior and active
  change planning.
