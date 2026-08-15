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

## Repository Skill Routing

The exact supported skill names are listed below. Do not invent aliases from
prompt filenames or from another tool's command syntax.

| Skill               | Use when                                                                 | Do not use it for                                      |
| ------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------ |
| `openspec-explore`  | Investigating a problem, comparing options, or clarifying requirements   | Editing files, authorizing work, or lifecycle changes  |
| `openspec-propose`  | Creating a complete proposal, design, delta specs, tasks, and `guard.json` | Implementation, task completion, commit, or archive    |
| `workflow-engine`   | Routing implementation, recovery, review, finalize, and archive work after planning | Inventing authority, signing, protected Apply, or manual managed Git |

`workflow-engine` is a non-authorizing routing guide. Executable workflow
commands remain the only authority for implementation recovery, completion,
managed commits, and archive transitions.

## Workflow Command Routing

### Planning, diagnosis, and assurance

| Command                                                     | Use when                                                        |
| ----------------------------------------------------------- | --------------------------------------------------------------- |
| `pnpm workflow doctor --json`                               | Diagnosing repository, dependency, hook, asset, or policy drift |
| `pnpm workflow validate-change <id> --json`                 | Validating tracked artifacts before a plan, task, or archive    |
| `pnpm workflow propose <id> --intent <intent.json> [--actor <id>] --json` | Starting the investigation-first planning wrapper |
| `pnpm workflow propose <id> --resume --input <envelope.json> --json` | Submitting the exact typed checkpoint returned by the wrapper |
| `pnpm workflow plan-commit <id> --json`                     | Underlying managed planning authority; routine proposals reach it through `propose` |
| `pnpm workflow ci --base <sha> --head <sha> [--input <integration-review.json>] --json` | Recomputing deterministic PR assurance and composing exact current PlanReview/TaskDiffReview coverage; `--input` resumes only the exact uncovered integration request |
| `pnpm workflow authority-plan prepare --intent <intent.json> --json` | Dry-running one whole-round authority-file plan without applying or signing |
| `pnpm workflow authority-plan status <plan-id> --json`      | Reading one durable authority round without advancing it        |
| `pnpm workflow authority-plan resume <plan-id> --json`      | Observing publication/merge state and advancing only non-signing durable substates |
| `pnpm workflow run-check <check-id> --json`                 | Running one registered non-destructive check on clean HEAD for evidence only |
| `pnpm workflow adapter evaluate --json`                   | Inspecting fixed adapter availability without launching a model  |
| `pnpm workflow adapter availability-pilot --record workflow/provider-availability-pilots/<name>.json --json` | Running the non-authoritative ordinary Codex/Claude read-only pilot and writing one create-only credential-safe result |
| `pnpm workflow adapter verify-availability-pilot --record workflow/provider-availability-pilots/<name>.json --json` | Recomputing the empirical pilot decision from its pinned Git and policy inputs |

`run-check` is for local or external-CI adapters that need the exact registered
runner and path scope. It does not authorize task completion, staging, commit,
archive, or merge; use the managed task lifecycle for those transitions.

### OpenSpec planning assets

| Command                                                                    | Use when                                                               |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `pnpm workflow openspec-assets generate --json`                            | Regenerating reviewed tool-plural planning assets during an upgrade    |
| `pnpm workflow openspec-assets check --json`                               | Checking tracked planning assets and their digest manifest             |
| `pnpm workflow openspec-assets install-prompts --codex-home <path> --json` | Installing reviewed prompt copies into an explicit local Codex target  |

Routine `openspec-propose` work must follow the returned `state`,
`nextAction`, and `inputSchema`; prompts must not author engine-owned
investigation, execution, PlanReview, or managed-ledger fields. The stable
claim-ID/hardness registry in `docs/WORKFLOW.md` governs assurance wording.
Preserve each registered hardness and owner, label future claims as
undelivered, and do not invent a stronger synonym.

A structured investigation exemption changes planning applicability only. It
does not waive PlanReview, task scope, execution strategy, checks, CI, or Git
transitions. A documentation or other task-execution exemption is a separate
execution fact and never creates an investigation exemption.

### Execution recovery, metrics, and evidence retention

| Command                                                        | Use when                                                               |
| -------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `pnpm workflow job list --json`                                | Listing durable execution jobs                                         |
| `pnpm workflow job status <job-id> --json`                     | Inspecting one job, its Attempt lineage, blocker, and accepted result   |
| `pnpm workflow job retry-request <job-id> --timeout <ms> --json` | Creating a scoped execution-budget grant request                        |
| `pnpm workflow job retry <job-id> --grant <grant-id> --json`   | Starting the exact human-approved replacement Attempt                   |
| `pnpm workflow job retry-pump --limit <count> --json`          | Processing a bounded set of due automatic replacement or probe schedules |
| `pnpm workflow job retry-schedules --json`                     | Inspecting durable automatic retry schedules                            |
| `pnpm workflow job retry-receipts [schedule-id] --json`        | Inspecting immutable retry/probe processing receipts                    |
| `pnpm workflow metrics show --json`                            | Reading production resilience, speed, governance, and storage metrics   |
| `pnpm workflow retention inspect --json`                       | Inspecting active, expiring, pinned, and pending-deletion evidence      |
| `pnpm workflow retention sweep --limit <count> --json`         | Running one bounded TTL pruning pass                                    |
| `pnpm workflow retention pin <workflow-id> <evidence-id> --reason <text> --json` | Human-only exact-evidence pin with a durable reason          |

Automatic retry processing is finite: each CLI or worker pass has an explicit
limit and persists its schedule/receipt state. It is not a daemon. Evidence is
never promoted to `pinned` automatically.

### Managed task lifecycle

| Command | Use when |
| ------- | -------- |
| `pnpm workflow open-task <id> [--task <task-id>] [--mandate <mandate-task-id>] --json` | Preferred entry: commit an owned draft when needed, then open the selected or next incomplete task; `--mandate` is required only for scope matching a configured protected role |
| `pnpm workflow finalize <session-id> --message "Subject" [--full-gate] --json` | Preferred ordinary exit: check, project, stage, and commit one exact task tree; a protected actual diff stops for human V2 Apply |
| `pnpm workflow status <session-id> --json` | Inspecting session state or resolving semantic task history |
| `pnpm workflow start <id> --task <task-id> [--mandate <mandate-task-id>] --json` | Deprecated compatibility entry for an already committed plan; scope matching a configured protected role still requires the mandate |
| `pnpm workflow check <session-id> --json` | Compatibility: producing fresh scoped check evidence |
| `pnpm workflow complete-task <session-id> --json` | Compatibility: applying the task and document projection |
| `pnpm workflow finish <session-id> --json` | Compatibility: rechecking and staging the exact task tree |
| `pnpm workflow finalize-task <session-id> --json` | Deprecated compatibility exit that leaves commit separate |
| `pnpm workflow commit <session-id> --message "Subject" --json` | Compatibility: committing an already finished exact tree |
| `pnpm workflow rollback-completion <session-id> --json` | Reverting an uncommitted completion projection through the engine |
| `pnpm workflow abort <session-id> --reason "Reason" --json` | Abandoning a pre-completion session without discarding files |

The routine lifecycle is `propose → [open-task → finalize]×N → archive`.
Each task keeps its own managed commit and evidence. An intermediate finalize
runs only that task's targeted `requiredChecks`. Planning should keep those
checks scoped to the task; it must not use the terminal full gate as a routine
per-task default. When an exact projection makes every task terminal, the
engine applies `workflow/config.json`'s `allTasksTerminalChecks`. A terminal
check may explicitly cover an otherwise duplicated task check; the repository
full gate covers `workflow-tests`, so that suite runs once, while unrelated
task checks remain required. `--full-gate` may request the same escalation
early. There is no agent-controlled defer flag. The compatible multi-command
path applies the same terminal-check policy and cannot bypass it. Never stage,
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
| `pnpm workflow maintainer grant preflight --profile <profile-id> --json` | Read-only validation of one reviewed V2 authority profile and exact current candidate |
| `pnpm workflow maintainer grant approve-and-apply ... --json` | Human-only exact-candidate V2 approval and atomic application |
| `pnpm workflow maintainer grant reissue-and-apply ... --json` | Human-only replacement of one terminal V2 attempt against the same governed candidate |
| `pnpm workflow authority-plan approve-and-apply <plan-id> --json` | Human-only local signing ceremony for the exact dry-run authority plan |
| `pnpm workflow authority-plan attest <plan-id> --json` | Human-only attestation ceremony after the protected-branch merge is observed |
| `pnpm workflow maintainer inspect [grant-id] --json` | Reading redacted local grant, reservation, or terminal state |
| `pnpm workflow maintainer revoke <grant-id> --reason <text> --json` | Human-only terminal revocation of an unused, reserved, or already-terminal grant with a durable reason; repeated use is cleanup-safe |

Legacy V1 issuance and authority-session entry are disabled; their parsers and
verifiers remain only for historical evidence and audited terminal cleanup.
Never stage or commit authority work manually, reuse a failed or expired grant,
or delete its audit tag to erase history. Until the remote prerequisites in
`docs/WORKFLOW.md` are independently verified, describe the facility as
bootstrap-only, not sealed enforcement.

### Issues and managed documents

| Command                                          | Use when                                                        |
| ------------------------------------------------ | --------------------------------------------------------------- |
| `pnpm workflow issue add ... --json`             | Adding a structured issue to `docs/issues/issues.yaml`          |
| `pnpm workflow issue update <id> ... --json`     | Updating an allowed field on a structured issue                 |
| `pnpm workflow issue close <id> ... --json`      | Closing a structured issue with a date and note                 |
| `pnpm workflow issue render --json`              | Regenerating `docs/ISSUE_LOG.md` after issue-source changes     |
| `pnpm workflow issue validate --json`            | Checking that issue source and generated view agree             |
| `pnpm workflow documents validate --json`        | Validating all managed-document policies and generated views    |
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

### Full-gate economy

Use targeted tests while iterating. Run the full gate once for a coherent batch;
at the exact merge or push tip, reuse that result when the commit/tree and
generated artifacts are unchanged. Run an additional full gate only after a
material merge or a high-risk lifecycle, security, or recovery change, and state
the reason. Never run duplicate or parallel full gates against the same tree.

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

## Explicit human override for workflow-engine repair

When the repository owner explicitly authorizes a named action, an agent may
perform that exact action without workflow-engine authorization only when
repairing or bootstrapping the workflow engine itself.

The authorization must identify the exact scope, worktree or branch, and
permitted Git operations. It does not authorize destructive operations,
secret access, signer impersonation, force-pushing protected branches, or
unrelated changes. The agent must preserve a recoverable snapshot and report
the actions and verification results.
