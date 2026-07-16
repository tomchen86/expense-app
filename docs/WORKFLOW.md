# Repository Workflow

_Last reviewed: July 16, 2026_

This repository plans changes with OpenSpec and executes them with the
repository-owned `pnpm workflow` engine. Spectra is retained only for
compatibility and historical reference; it is not an execution path.

## Ownership Model

| Concern                                        | Authoritative source                            |
| ---------------------------------------------- | ----------------------------------------------- |
| Current requirements                           | `openspec/specs/<capability>/spec.md`           |
| Proposed requirement deltas, design, and tasks | `openspec/changes/<change-id>/`                 |
| Per-task path scope and required check IDs     | `openspec/changes/<change-id>/guard.json`       |
| Project priority                               | `docs/ROADMAP.md`                               |
| Current handoff                                | generated `docs/CURRENT_AND_NEXT_STEPS.md`      |
| Structured issues                              | `docs/issues/issues.yaml`                       |
| Runtime sessions, locks, and reports           | the Git common directory, managed by the engine |
| Commit and branch history                      | Git                                             |

Markdown does not authorize completion. A checked task, handoff update, staged
index, or commit is valid only when the workflow engine produces it from
current evidence.

## Managed Transition Matrix

| Kind    | Exact trailers                           | Public authority                          |
| ------- | ---------------------------------------- | ----------------------------------------- |
| Task    | `Change: <id>` and `Task: <task-id>`     | session `complete-task`/`finish`/`commit` |
| Plan    | `Change: <id>` and `Transition: plan`    | `pnpm workflow plan-commit <id>`          |
| Archive | `Change: <id>` and `Transition: archive` | `pnpm workflow archive <id>`              |

The forms are mutually exclusive. A plan or archive commit has no `Task:`
trailer, a task commit has no `Transition:` trailer, and none may be mixed with
extra managed trailers. Do not hand-author the trailers or use raw `git commit`
for one of these transitions.

## Before Starting

1. Read `AGENTS.md`, `docs/ROADMAP.md`, and
   `docs/CURRENT_AND_NEXT_STEPS.md`.
2. Read the active change's proposal, design, delta specs, tasks, and
   `guard.json`.
3. For production behavior or a bug fix, identify or add the test that will
   fail for the intended reason before changing implementation code. Record the
   reason when a documentation-only, formatting-only, dependency-only, or
   time-boxed research task is exempt from RED -> GREEN -> REFACTOR.
4. Work on the configured `work/<change-id>` branch with a clean worktree. A
   detached HEAD, protected branch, or other branch name is not eligible.
5. Diagnose the repository and validate the tracked change:

   ```bash
   pnpm workflow doctor --json
   pnpm workflow validate-change <change-id> --json
   ```

`doctor` is diagnostic. It can exit successfully while reporting warnings, so
read its output. A successful diagnostic does not grant permission to skip any
later transition.

### Bootstrap and routine maintenance

Run `pnpm install` from the repository root to install the exact lockfile and
the repository hooks through the root `prepare` script. Do not substitute a
global or floating OpenSpec binary. After install or toolchain maintenance,
run:

```bash
pnpm workflow doctor --json
pnpm workflow codex-assets check --json
pnpm workflow documents validate --json
```

Treat dependency, schema provenance, generated-asset, hook, or managed-document
drift as a reviewed change. Remote repository rules remain maintainer-owned and
must be verified separately; a local hook or checked-in workflow file does not
prove that `workflow-assurance` is required for merge.

## Planning Lifecycle

OpenSpec owns proposal, design, delta-spec, task, and artifact-graph creation.
It does not authorize implementation or Git transitions. Create or revise the
artifacts on the exact `work/<change-id>` branch, keep every task unchecked,
then submit the planning-only diff with:

```bash
pnpm workflow validate-change <change-id> --json
pnpm workflow plan-commit <change-id> --json
```

`plan-commit` rejects implementation files, normative base specs, archives,
task-checkbox changes, an active session, wrong branches, and unrelated
planning paths. It validates the pinned OpenSpec graph and repository contract,
records current evidence, stages the exact planning paths, and creates the plan
form from the transition matrix. A later planning revision uses the same
command and invalidates stale task evidence.

Repository planning assets are limited to the exact exposed skill names
`openspec-explore` and `openspec-propose`, with reviewed prompt copies and a
digest manifest under `workflow/codex-assets/`. Use `openspec-explore` for
read-only investigation and requirement clarification. Use `openspec-propose`
to create a complete proposal, design, delta specs, tasks, and `guard.json`.
Do not infer a slash command or alias from an internal prompt filename. If the
running Codex UI does not expose the skills, use the pinned OpenSpec planning
CLI directly and record the discovery result in the post-merge pilot.

## Managed Task Lifecycle

### 1. Start the selected current task

```bash
pnpm workflow start <change-id> --task <task-id> --json
```

Choose the current task named by the handoff and keep the returned session ID.
Start fails closed for a protected branch, dirty baseline, unknown or already
completed task, an active session for the same change, or invalid change
contract. Task ordering is authorized later by completion reconciliation and
CI, not by session creation. The session snapshots the change contract,
allowed paths, required check IDs, and their policy digests.

### 2. Implement within the session boundary

- Change only paths allowed for that task.
- Treat `guard.json` as machine policy, not a place for task prose.
- Do not edit task checkboxes or the generated handoff.
- Do not stage or commit managed work manually.
- Do not change policy to legitimize a diff that the starting policy rejected.
- The engine does not stash, reset, or delete working-tree files on your
  behalf.
- Never run a destructive API test without an explicitly disposable
  `TEST_DATABASE_URL`; development-database fallback is forbidden.

Inspect a session or resolve semantic task-to-commit history with:

```bash
pnpm workflow status <session-id> --json
```

### 3. Produce current check evidence

```bash
pnpm workflow check <session-id> --json
```

The engine rejects out-of-scope paths and executes only the task's configured
check IDs through their pinned runners. Reports bind the current diff
fingerprint, policy, artifact, required-check and runner digests, and passing
outcomes; each report is itself content-addressed. Any later content change
makes earlier evidence stale, so run `check` again after a correction.

### 4. Let the engine complete, stage, and commit

Run these transitions in order:

```bash
pnpm workflow complete-task <session-id> --json
pnpm workflow finish <session-id> --json
pnpm workflow commit <session-id> --message "Imperative subject" --json
```

- `complete-task` accepts only current passing evidence, updates the exact task
  checkbox, and regenerates controlled documents such as the semantic handoff.
- `finish` verifies the completion projection, reruns the required checks, and
  stages the exact authorized tree.
- `commit` rejects index drift and creates the commit with exact
  `Change: <change-id>` and `Task: <task-id>` trailers.

The commit subject must be one trimmed line without control characters or
trailers. If commit ref advancement is interrupted after the commit object is
created, rerun the same `commit` command so the engine can reconcile it.

Do not write a commit hash into `CURRENT_AND_NEXT_STEPS.md` or create a
hash-only metadata commit. Use Git or `workflow status` when a hash is needed.

### 5. Abort only when abandoning the session

```bash
pnpm workflow abort <session-id> --reason "Concrete reason" --json
```

Abort is available only before the session has a completion, finish, or commit
report. It records the reason and releases the session; it does not discard or
reset working-tree changes.

## Archive Lifecycle

Archive is a separate managed transition, not a synthetic task. Every task
must already be completed by exactly one canonical task commit reachable from
the first configured protected branch. There must be no active session or
unowned worktree/index change. After the task commits have been merged into
that configured base, create a clean archive branch from the updated base and
run:

```bash
pnpm workflow validate-change <change-id> --json
pnpm workflow archive <change-id> --json
```

The engine runs the exact pinned OpenSpec archive operation only in a detached
temporary worktree. It validates the returned JSON and roots, archive date,
delta outcomes, rebuilt specs, modes, digests, and exact patch before touching
the real worktree. It then compare-and-swap commits the archive form from the
transition matrix. A repeated `archive` call is an idempotency check: it may
return only the one already-archived identity accepted by the engine.

Do not run `openspec archive` directly, manually move the change directory,
stage an archive, or use an OpenSpec apply/sync/bulk lifecycle interface.

## Pull Request Assurance

The authoritative verifier receives exact commit objects:

```bash
pnpm workflow ci --base <base-commit> --head <head-commit> --json
```

It requires an ancestor base and clean checkout, verifies every managed commit
against task order, trailers, path scope, anchored policy, and task-state
projection, then recomputes required checks. Runtime reports from a developer
session are not trusted as CI evidence.

`.github/workflows/workflow-assurance.yml` invokes this verifier for pull
requests. Repository rules must separately require pull requests, the
`workflow-assurance` check, an up-to-date base, and no bypass. Code-owner
approval with stale-review dismissal is additionally required only when at
least two independent eligible human maintainers exist. Until those remote
rules are configured, local and workflow-file enforcement must not be described
as merge authority.

### Standalone registered checks

Use the evidence-only entry point below when local verification or an external
CI job must execute exactly one non-destructive check from
`workflow/checks.json`:

```bash
pnpm workflow run-check <check-id> --json
```

The command requires a clean checkout, resolves the named registry entry,
executes it through the same pinned runner used by managed checks and replay,
binds the result to current HEAD, and rejects checkout mutation. It fails before
execution for an unknown or destructive check. Its structured result is check
evidence only: it cannot authorize task completion, staging, commit, archive,
or a merge.

CI and package-script adapters must delegate to this command instead of copying
a registered command or maintaining another path scope. In particular,
formatting verification resolves `workflow-format`; the registry entry remains
the sole authority for its Prettier paths.

## Controlled Issues and Documents

### Issues

`docs/issues/issues.yaml` is the editable structured source even though its
extension is YAML; it must remain JSON-compatible. `docs/ISSUE_LOG.md` is a
deterministic generated view and must not be edited or formatted by hand.

```bash
pnpm workflow issue add --id <ISS-nnn> --category <category> --title <title> \
  --status <status> --priority <priority> --notes <notes> --json
pnpm workflow issue update <ISS-nnn> --field <field> --value <value> --json
pnpm workflow issue close <ISS-nnn> --date <YYYY-MM-DD> --notes <notes> --json
pnpm workflow issue render --json
pnpm workflow issue validate --json
```

After every issue mutation, render and validate the generated log. An optional
requirement link on `issue add` requires both `--requirement-label` and
`--requirement-href`. Repeat `--reference` for multiple references.

Accepted categories are `feature`, `bug`, and `enhancement`; statuses are
`proposed`, `in-progress`, `done`, `blocked`, and `icebox`; priorities are
`Now`, `Next`, and `Later`. `issue update` supports `title`, `status`,
`priority`, and `notes`. Feature IDs use `ISS-000` through `ISS-099`, bug IDs
use `ISS-100` through `ISS-199`, and enhancement IDs use `ISS-200` through
`ISS-999`.

### Managed and curated documents

Validate generated/managed documents with:

```bash
pnpm workflow documents validate --json
pnpm workflow handoff validate --json
```

The handoff is generated from controlled change and issue state. Use
`pnpm workflow handoff render --json` only inside an authorized task scope.

Curated section refreshes under `docs/architecture/**` and `docs/features/**`
use separate propose, inspect, review, and apply records:

```bash
pnpm workflow document-refresh propose --target <path> --section <heading> \
  --replacement <markdown> --json
pnpm workflow document-refresh show --proposal <proposal-id> --json
pnpm workflow document-refresh review --proposal <proposal-id> \
  --decision <approve-or-reject> --reviewer <identity> --json
pnpm workflow document-refresh apply --proposal <proposal-id> \
  --review <review-id> --json
```

Approval is bound to the exact proposal. A changed source document or policy
invalidates the apply operation.

## Failure Classes

| Exit | Meaning                                               |
| ---- | ----------------------------------------------------- |
| `1`  | unexpected internal failure                           |
| `2`  | invalid command or arguments                          |
| `10` | guard or policy rejection                             |
| `11` | lock or active-session conflict                       |
| `12` | unsafe environment, including database policy failure |
| `13` | check or validation failure                           |
| `14` | stale or tampered state                               |

Treat a nonzero exit as a stop condition. Correct the underlying input and
produce fresh evidence; do not bypass hooks, edit reports, or manually perform
the rejected transition.

## Recovery and Rollback

- If implementation changes after `check`, rerun `check`; old evidence is
  intentionally stale.
- If `finish` fails, inspect `git status` and `workflow status`, correct only
  the authorized input, and rerun the managed transition. Do not reset, stash,
  hand-stage, edit reports, or create a replacement commit.
- If commit ref advancement is interrupted, rerun the same managed command.
  The engine reconciles only the exact report/tree/commit identity.
- If planning or archive validation fails, preserve the error and worktree
  state. Archive upstream failures remain isolated; real-worktree drift or an
  ownership mismatch is a stop condition, not permission for manual repair.
- Before a successful real pilot, rollback of this integration requires a
  separately reviewed logical revert. Keep OpenSpec artifacts readable as
  Markdown/JSON, do not archive a partial migration, and do not delete
  user/global state.
- After the pilot, change OpenSpec, schema, workflow policy, or generated-asset
  contracts only through a new proposal with compatibility tests.

## OpenSpec Upgrade Procedure

Every OpenSpec upgrade is a separate reviewed change. In that change:

1. Update `@fission-ai/openspec` to one exact version in `package.json` and the
   matching integrity-pinned `pnpm-lock.yaml` resolution. Keep
   `allowBuilds['@fission-ai/openspec']` explicitly `false`.
2. Inspect the installed public CLI and packaged `schemas/spec-driven` source.
   Review and update the `expense-app` schema fork and
   `openspec/schemas/expense-app/provenance.json`; do not deep-import internals
   or copy the archive merge implementation.
3. Regenerate and compare the planning-only Codex assets:

   ```bash
   pnpm workflow codex-assets generate --json
   pnpm workflow codex-assets check --json
   ```

4. Run `pnpm workflow doctor --json`, validate every affected active change,
   and run the workflow tests, typecheck, lint, and format checks through the
   change's registered checks.
5. Require CI to recompute dependency, schema provenance, generated assets,
   planning, tasks, and archive replay from Git. Do not weaken a validator to
   accept unexplained upstream drift.

## Maintainer-Owned Post-Merge Pilot

The disposable repository rehearsal proves the implementation path but is not
the real pilot. Support remains undeclared until a maintainer performs this
gate after the integration is merged and reachable from the configured base:

1. Update the configured base locally and create a new small, non-database
   OpenSpec change with one task and a harmless, tightly scoped repository
   change. Use a new `work/<pilot-change-id>` branch. Create planning artifacts
   with the pinned OpenSpec interface; use a Codex skill only if that running UI
   visibly exposes it.
2. Validate its complete planning tree and create the plan commit:

   ```bash
   pnpm workflow validate-change <pilot-change-id> --json
   pnpm workflow plan-commit <pilot-change-id> --json
   ```

3. Execute its one task with the full managed sequence:

   ```bash
   pnpm workflow start <pilot-change-id> --task <task-id> --json
   pnpm workflow check <session-id> --json
   pnpm workflow complete-task <session-id> --json
   pnpm workflow finish <session-id> --json
   pnpm workflow commit <session-id> --message "Complete pilot task" --json
   ```

   Record the semantic change/task IDs, exact commands, check outcomes, and
   observed Codex skill-discovery surface in the pilot review; do not put
   commit hashes in the semantic handoff.

4. Merge the task commit into the configured base through normal review, then
   create a fresh archive branch from the updated base and run the following
   command twice:

   ```bash
   pnpm workflow archive <pilot-change-id> --json
   ```

   The second result must be `already-archived` for the same identity.

5. Open the archive change for review and require the real
   `workflow-assurance` PR check. For a local replay, pass the exact archive
   parent and archive head:

   ```bash
   pnpm workflow ci --base <base-commit> --head <head-commit> --json
   ```

6. Verify that CI succeeds without developer runtime reports and that only the
   UTC date prefix varies if the replay crosses a day. Declare support only
   after all results are recorded and the required remote rule is confirmed.

Do not perform this pilot inside the integration branch, describe the
disposable rehearsal as the pilot, or invent a Codex invocation the UI did not
surface.

## Archived Legacy Material

Superseded checklists, plans, status reports, logs, and templates are preserved
under `docs/archive/legacy/` using their former path below `docs/`. They are
immutable historical inputs and never override this workflow or current
canonical documents. Editing, restoring, renaming, or deleting archived
material requires new explicit maintainer approval.
