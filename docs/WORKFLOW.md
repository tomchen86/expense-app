# Repository Workflow

_Last reviewed: July 15, 2026_

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
requests. Repository rules must separately require the `workflow-assurance`
check, an up-to-date base, code-owner approval with stale-review dismissal,
and no bypass. Until those remote rules are configured, local and workflow-file
enforcement must not be described as merge authority.

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

## Retained Legacy Material

`docs/UPDATE_CHECKLIST.md`, older planning/status/log documents, and the
retained Spectra installation are historical or compatibility inputs. They do
not override this workflow. Moving, deleting, or archiving retained legacy
documents requires separate explicit maintainer approval.
