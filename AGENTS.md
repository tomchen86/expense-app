# Repository Workflow

This repository uses OpenSpec artifacts as versioned planning data and a
repository-owned workflow engine for execution assurance.

- Normative requirements live in `openspec/specs/`.
- Proposals, designs, delta specs, and task lists live in
  `openspec/changes/<change-id>/`.
- `guard.json` contains machine policy only: task path scope and required check
  IDs.
- Runtime sessions, locks, reports, Git validation, and completion authority
  belong to the executable workflow engine, not to Markdown or an AI prompt.
- `docs/ROADMAP.md` owns priority; generated
  `docs/CURRENT_AND_NEXT_STEPS.md` owns the current handoff.

Only an executable workflow command may authorize a planning commit, task
completion, controlled-document update, staging, managed commit, or archive.
Never treat an AI claim, checked box, or prose status as evidence.

Break-glass authority is human-only. An agent may explain the maintainer
commands or prepare an ordinary reviewed OpenSpec change, but must not attempt
to satisfy the controlling-terminal, trusted-signer, protected-tag, or remote
approval requirements on the maintainer's behalf.

## Planning Skill Routing

The exact supported skill names are listed below. Do not invent aliases from
prompt filenames or from another tool's command syntax.

| Skill               | Use when                                                                 | Do not use it for                                      |
| ------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------ |
| `openspec-explore`  | Investigating a problem, comparing options, or clarifying requirements   | Editing files, authorizing work, or lifecycle changes  |
| `openspec-propose`  | Creating a complete proposal, design, delta specs, tasks, and `guard.json` | Implementation, task completion, commit, or archive    |

There is no repository skill for implementation, recovery, completion,
commit, or archive. Use the workflow commands below for those operations.

## Workflow Command Routing

### Planning, diagnosis, and assurance

| Command                                                     | Use when                                                        |
| ----------------------------------------------------------- | --------------------------------------------------------------- |
| `pnpm workflow doctor --json`                               | Diagnosing repository, dependency, hook, asset, or policy drift |
| `pnpm workflow validate-change <id> --json`                 | Validating tracked artifacts before a plan, task, or archive    |
| `pnpm workflow plan-commit <id> --json`                     | Committing a new or revised planning-only change                |
| `pnpm workflow ci --base <sha> --head <sha> --json`         | Recomputing PR assurance from exact Git commits                 |
| `pnpm workflow run-check <check-id> --json`                 | Running one registered non-destructive check on clean HEAD for evidence only |
| `pnpm workflow adapter evaluate --input <path> --json`      | Evaluating a supported AI adapter request under repository policy |

`run-check` is for local or external-CI adapters that need the exact registered
runner and path scope. It does not authorize task completion, staging, commit,
archive, or merge; use the managed task lifecycle for those transitions.

### OpenSpec planning assets

| Command                                                                    | Use when                                                               |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `pnpm workflow openspec-assets generate --json`                            | Regenerating reviewed tool-plural planning assets during an upgrade    |
| `pnpm workflow openspec-assets check --json`                               | Checking tracked planning assets and their digest manifest             |
| `pnpm workflow openspec-assets install-prompts --codex-home <path> --json` | Installing reviewed prompt copies into an explicit local Codex target  |

### Managed task lifecycle

| Command                                                        | Use when                                                       |
| -------------------------------------------------------------- | -------------------------------------------------------------- |
| `pnpm workflow start <id> --task <task-id> --json`             | Opening one authorized task session on `work/<id>`             |
| `pnpm workflow status <session-id> --json`                     | Inspecting session state or resolving semantic task history    |
| `pnpm workflow check <session-id> --json`                      | Producing fresh scoped check evidence for the current diff     |
| `pnpm workflow complete-task <session-id> --json`              | Applying the task checkbox and generated-document projection   |
| `pnpm workflow finish <session-id> --json`                     | Rechecking and staging the exact authorized task tree          |
| `pnpm workflow commit <session-id> --message "Subject" --json` | Creating the managed task commit with engine-owned trailers  |
| `pnpm workflow rollback-completion <session-id> --json`        | Reverting an uncommitted completion projection through the engine |
| `pnpm workflow abort <session-id> --reason "Reason" --json`   | Abandoning a pre-completion session without discarding files   |

Run `start` → implement → `check` → `complete-task` → `finish` →
`commit`. If content changes after `check`, run `check` again. Never stage,
edit checkboxes, or commit managed task work by hand.

### Archive transition

| Command                                     | Use when                                                         |
| ------------------------------------------- | ---------------------------------------------------------------- |
| `pnpm workflow archive <id> --json`         | Archiving a fully completed change after its task commits are on the configured base |

Archive is a separate transition. Do not manually move an active OpenSpec
change or run an upstream archive command directly.

### Human-only break-glass maintenance

These commands are not an alternate task lifecycle. Grant issuance and commit
creation require the eligible maintainer at a controlling interactive terminal;
use `docs/WORKFLOW.md` for the complete bootstrap, pilot, sealing, and recovery
procedure.

| Command | Use when |
| ------- | -------- |
| `pnpm workflow maintainer grant ... --json` | A human maintainer is issuing one short-lived, single-use grant for sorted exact eligible authority paths |
| `pnpm workflow maintainer inspect [grant-id] --json` | Reading redacted local grant, reservation, or terminal state |
| `pnpm workflow maintainer revoke <grant-id> --json` | Terminally revoking an unused, reserved, or already-terminal grant; repeated use is cleanup-safe |
| `pnpm workflow authority-start <id> --grant <grant-id> --json` | Reserving the published grant on the exact clean `work/<id>` branch and base |
| `pnpm workflow authority-check <session-id> --json` | Running all base-pinned normal checks against an exact-path authority diff |
| `pnpm workflow authority-commit <session-id> --message "Subject" --json` | Creating the signed authority-maintenance commit and consuming the grant from current evidence |
| `pnpm workflow authority-recover <session-id> --json` | Finalizing only an exact durable commit journal after an interrupted authority commit |
| `pnpm workflow authority-abort <session-id> --reason "Reason" --json` | Cancelling an active pre-commit authority session and terminally revoking its grant |

Never stage or commit authority work manually, reuse a failed or expired grant,
delete its audit tag to erase history, or use `authority-recover` as a general
retry. Until the remote prerequisites in `docs/WORKFLOW.md` are independently
verified, describe the facility as bootstrap-only, not sealed enforcement.

### Issues and managed documents

| Command                                          | Use when                                                        |
| ------------------------------------------------ | --------------------------------------------------------------- |
| `pnpm workflow issue add ... --json`             | Adding a structured issue to `docs/issues/issues.yaml`          |
| `pnpm workflow issue update <id> ... --json`     | Updating an allowed field on a structured issue                 |
| `pnpm workflow issue close <id> ... --json`      | Closing a structured issue with a date and note                 |
| `pnpm workflow issue render --json`              | Regenerating `docs/ISSUE_LOG.md` after issue-source changes     |
| `pnpm workflow issue validate --json`            | Checking that issue source and generated view agree             |
| `pnpm workflow documents validate --json`        | Validating all managed-document policies and generated views    |
| `pnpm workflow handoff render --json`             | Regenerating the handoff inside an authorized task scope        |
| `pnpm workflow handoff validate --json`           | Checking the handoff against controlled change and issue state  |

### Curated document refresh

| Command                                                     | Use when                                                     |
| ----------------------------------------------------------- | ------------------------------------------------------------ |
| `pnpm workflow document-refresh propose ... --json`         | Proposing an exact reviewed-section replacement              |
| `pnpm workflow document-refresh show --proposal <id> --json` | Inspecting the bound proposal and source digest               |
| `pnpm workflow document-refresh review ... --json`          | Recording an independent approve/reject decision              |
| `pnpm workflow document-refresh apply ... --json`           | Applying the exact approved replacement if inputs are current |

### Hook entry points

These are normally invoked by Git or CI rather than by an agent directly.

| Command                                      | Use when                                                |
| -------------------------------------------- | ------------------------------------------------------- |
| `pnpm workflow hook pre-commit`              | Validating a pending commit through the installed hook  |
| `pnpm workflow hook commit-msg <path>`       | Validating commit-message structure and managed trailers |
| `pnpm workflow hook pre-push ...`            | Validating the pushed commit range                      |
| `pnpm workflow hook post-merge`              | Checking repository state after a merge or pull         |

Managed commit forms are mutually exclusive:

| Kind    | Exact trailers                                   | Command family              |
| ------- | ------------------------------------------------ | --------------------------- |
| Task    | `Change: <id>` and `Task: <task-id>`             | session lifecycle           |
| Plan    | `Change: <id>` and `Transition: plan`            | `workflow plan-commit`      |
| Archive | `Change: <id>` and `Transition: archive`         | `workflow archive`          |
| Authority | `Change: <id>`, `Transition: authority-maintenance`, and `Grant: <grant-id>` | human-only authority lifecycle |

Do not hand-author or mix these trailers. The exact lifecycle, recovery,
upgrade, and post-merge pilot procedures are in `docs/WORKFLOW.md`.

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
- `apps/web/` – ordinary-directory placeholder; no current web capability is claimed.
- `docs/` – project overview, roadmap, handoff, workflow, architecture, feature references, and immutable archive.
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

- Use TypeScript and prefer focused modules with clear responsibilities.
- Do not change, split, or refactor source solely because it exceeds 500 lines.
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
- Managed task commits include exact `Change: <change-id>` and
  `Task: <task-id>` trailers; plan and archive commits use their exact
  `Transition:` form from the matrix above. Use Git or `workflow status` to
  resolve hashes; never write commit hashes into
  `docs/CURRENT_AND_NEXT_STEPS.md` or create a hash-only metadata commit.
- PRs should:
  - Summarize intent and reference planning docs/issues.
  - List executed commands (`pnpm --filter api test -- ...`).
  - Attach screenshots/logs for UX or tooling adjustments.
  - Call out follow-up tasks, migrations, or env changes explicitly.

## Security & Configuration Tips
- Do not commit secrets; use environment variables defined in docs.
- For local dev, stash secrets in `.env.local` (ignored) and document required keys in the PR.
- Run `pnpm --filter api build` and targeted tests before pushing to avoid CI regressions.
