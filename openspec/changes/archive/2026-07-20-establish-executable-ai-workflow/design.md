# Design: Executable AI Workflow Assurance

## Responsibility Split

```text
docs/ROADMAP.md
        |
        v
openspec/specs + openspec/changes
  requirements / proposal / design / tasks / delta specs
        |
        v
guard.json
  per-task allowed paths and required check IDs
        |
        v
repository workflow engine
  Git facts / session / lock / diff / checks / evidence
        |
        v
Git hooks (local feedback) + CI (authoritative merge boundary)
```

There is no parallel planning tree under `workflow/`. That directory contains
only executable configuration, schemas, and document policy.

## Trust Boundary

The AI, Markdown, configuration input, path input, stored session booleans, and
the working tree are untrusted. The engine recomputes repository facts with
fixed executable arguments and never evaluates commands from prose.

The initial CLI can guarantee that its own `start` command creates no active
session unless preflight passes. It cannot stop a human or unrelated process
from editing the repository. Diff verification, hooks, CI, and eventually a
controlled adapter close progressively stronger boundaries.

## Tracked Artifacts

- `openspec/specs/**`: normative current behavior.
- `openspec/changes/<change-id>/proposal.md`: intent, scope, non-goals.
- `design.md`: architecture and trade-offs.
- `specs/**`: normative deltas.
- `tasks.md`: ordered human-readable task projection.
- `guard.json`: deterministic JSON containing machine policy only.
- `workflow/config.json`: repository/branch/runtime policy.
- `workflow/checks.json`: allowlisted commands represented as argv arrays.
- `workflow/document-policy.json`: managed-document mutation policy.

## Runtime State

Runtime files live under the Git common directory:

```text
<git-common-dir>/workflow-engine/
├── locks/
├── operations/
├── sessions/
└── reports/
```

They are never added to the worktree. Session creation uses an exclusive lock
and atomic temporary-file rename. Stored facts are pinned with SHA-256 digests
and revalidated rather than blindly trusted.

## Bootstrap Commands

```text
workflow doctor
workflow validate-change <change-id>
workflow start <change-id> --task <task-id>
workflow status [session-id]
workflow check <session-id>
workflow complete-task <session-id>
workflow finish <session-id>
workflow commit <session-id> --message <subject>
workflow abort <session-id> --reason <text>
```

`doctor` is diagnostic and may report a dirty/protected-branch warning without
failing. `start` is blocking: it requires the expected non-protected branch, a
completely clean baseline, valid artifacts, known checks, and no active lock.

Completion, finish, and commit remain serialized by a per-session operation
lock. Passing checks produce content-addressed immutable reports. Completion
projects only the authorized checkbox bytes, finish reruns the pinned checks
and stages the exact verified path set, and commit creates an exact Git commit
object before atomically advancing the branch ref with a compare-and-swap.
Authorized commits bypass repository hooks because local hooks are feedback,
not commit authority; postconditions still verify parent, tree, paths, and
message bytes before the ref update.

## Path Policy

The bootstrap supports repository-relative exact paths and directory prefixes
ending in `/**`. Absolute paths, traversal, empty paths, ambiguous glob syntax,
and symlink escapes are rejected. Prefix matching is segment-aware, so
`apps/api/**` does not match `apps/api-copy/file.ts`.

## Check Execution and Database Safety

Required check IDs resolve only through `workflow/checks.json`. The engine
accepts only `node` and `node-package-bin` command runners. `node` maps to the
engine's `process.execPath`; package bins resolve from a declared workspace
package and are invoked through that same Node executable. Bare executables,
the caller's `PATH`, global pnpm, shell interpolation, and `eval` are not
execution authorities. Runner realpaths and entrypoint digests are checked
before and after execution. A non-zero exit, signal, spawn error, or runner
mutation fails verification with structured evidence.

Before any check marked `destructiveDatabase` starts, all destructive checks
are preflighted together. The operator must set
`WORKFLOW_DISPOSABLE_DATABASE=1` and an explicit PostgreSQL
`TEST_DATABASE_URL`. The parsed database name must contain a disposable token
(`test`, `ci`, `tmp`, `temp`, `disposable`, or `ephemeral`), must not contain a
development/shared/staging/production token, and must not identify the same
server/database as `DATABASE_URL`. Output and errors expose only a redacted
database identity without credentials, query, fragment, or raw URL.

When the API harness receives an explicit `TEST_DATABASE_URL`, failure to
connect is terminal. It does not continue to `COMPOSE_TEST_DATABASE_URL`, a
development URL, or an auto-provisioned target. This preserves the engine's
validated database decision through the test harness itself.

## Bootstrap Exception

The engine cannot guard the edits that create itself. This change therefore
records bootstrap work as an explicit exception. After the kernel is committed,
new task checkbox transitions must be authorized by workflow evidence; the
bootstrap exception cannot be reused for product work.

## Document Safety

The policy registry begins in audit-only mode. A document mode is not described
as a hard guarantee until its command, validator, bypass tests, and CI boundary
exist. `ISSUE_LOG.md` becomes generated-only only after structured source is
seeded and lossless rendering is proven.

## Handoff and Commit Traceability

`docs/CURRENT_AND_NEXT_STEPS.md` contains exactly the current change, current
task, next task, current focus, known blockers, and durable references. It does
not record commit hashes or runtime session facts. A document cannot contain
the hash of the commit that creates it, and a second commit whose only purpose
is copying the first hash is prohibited by the design.

Managed commits use exact `Change:` and `Task:` trailers. The engine may resolve
and display matching commits from Git at runtime without copying those hashes
back into tracked current-state documents.

## Spectra Boundary

Spectra files remain present, but repository instructions prohibit invoking its
commands, skills, lifecycle state, or adapters. No engine module imports or
executes Spectra.
