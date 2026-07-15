# Design: OpenSpec Planning with Workflow Assurance

## Context

The repository already has an executable workflow engine that owns task
sessions, locks, path policy, check execution, evidence, checkbox projection,
staging, commit construction, Git hooks, and CI recomputation. Its current
change loader treats the OpenSpec-shaped tree as a static repository contract;
it does not invoke OpenSpec or support dedicated planning and archive
transitions.

```text
OpenSpec
  proposal / design / delta specs / tasks / graph / templates
        |
        v
pnpm workflow
  policy / sessions / checks / evidence / Git transitions / archive gate
        |
        v
local hooks for feedback + CI for authoritative recomputation
```

The trust boundary is executable. Markdown, AI output, generated skills,
OpenSpec process output, user configuration, runtime reports, and the working
tree remain untrusted until the workflow engine validates or recomputes them.

OpenSpec 1.6.0 has relevant constraints: schema validation may exit zero with
`valid: false`; artifact readiness mostly proves file existence; user schemas
and stores can alter resolution; archive is not transactional; its delta merge
implementation is not a public export; and its generated core profile exposes
lifecycle workflows this repository must not provide.

The repository's canonical `pnpm workflow:test` passes from the root, while the
package-owned filtered test command currently exposes root paths through
`process.cwd()` and fails from the package directory. The first managed task
will make repository fixture/path discovery independent of the caller's CWD
before adding integration behavior. OpenSpec also creates the reserved
`openspec/changes/archive/` container; current active-change enumeration treats
that container as a change, so the same task will add a regression and exclude
it without hiding valid active changes.

## Goals / Non-Goals

**Goals:**

- Make OpenSpec the repository planning and artifact-graph engine.
- Keep `pnpm workflow` as the only execution, evidence, checkbox, Git, and
  archive authority.
- Validate OpenSpec through a typed, pinned, isolated subprocess adapter.
- Add an `expense-app` project schema containing `guard.json`.
- Add executable planning and archive transitions.
- Provide reproducible planning-only Codex integration.
- Extend workflow hooks and CI to recompute all transition facts.
- Prove the complete path with an end-to-end pilot.

**Non-Goals:**

- Do not add a second change/task model or `workflow create-change`.
- Do not give OpenSpec authority over completion, staging, commit, or archive
  acceptance.
- Do not expose apply, sync, archive, or bulk-archive skills/prompts.
- Do not vendor, execute, delete, or rewrite `OpenSpec-main/` or retained
  Spectra components.
- Do not deep-import OpenSpec internals or mutate a real user Codex home during
  install, tests, generation, or CI.
- Do not change API, mobile, web, or database behavior.

## Decisions

### 1. OpenSpec owns planning; the workflow engine owns assurance

OpenSpec owns change creation, artifact templates/instructions, graph
readiness, schema resolution, and delta syntax. The workflow owns `guard.json`
semantics, sessions, locks, registered checks, evidence, task projection, Git
transitions, archive verification, and CI recomputation. Skills and prompts are
interfaces only and cannot provide evidence.

Making raw OpenSpec lifecycle commands authoritative would bypass repository
checks and exact Git state. Reimplementing planning under `workflow/` would
create duplicate state. Both alternatives are rejected.

### 2. Pin OpenSpec and deny its optional install script

The root uses exact dependency `"@fission-ai/openspec": "1.6.0"` and commits the
matching lock resolution. The existing supply-chain policy sets:

```yaml
allowBuilds:
  '@fission-ai/openspec': false
```

The denied postinstall only prints an optional completion hint; the packaged
CLI does not require it. Workflow code resolves the installed absolute
`bin/openspec.js` and invokes it with `process.execPath` and fixed argv. It does
not use a shell, `npx`, a global/floating binary, caller `PATH`, or
`OpenSpec-main/`.

Machine calls set `OPENSPEC_TELEMETRY=0`, `DO_NOT_TRACK=1`, and `CI=true`, and
isolate `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, and `CODEX_HOME`. Every
upgrade is a separate reviewed change with contract and generated-asset tests.

### 3. Use one typed, fail-closed subprocess adapter

All machine calls use private typed operations such as version, schema
resolution/validation, status, instructions, change validation, all-spec
validation, planning creation, and sandbox archive. There is no public generic
argv pass-through.

The adapter uses a canonical repository or temporary-worktree `cwd`, enforces
timeout/output limits, captures stdout and stderr separately, parses exactly
one JSON document, validates operation-specific payloads, checks every returned
root/path, rejects stores/ancestors/symlink aliases/escapes, and accepts only
operation-specific known stderr diagnostics. A zero exit code alone never
proves success. Reports record the observed OpenSpec version.

### 4. Fork and supplement the project schema

The pinned package `spec-driven` schema is forked to project schema
`openspec/schemas/expense-app`, preserving proposal/specs/design/tasks and
adding a `guard` artifact required after tasks. Apply readiness requires tasks
and guard and continues to track `tasks.md`.

Before forking, `schema which spec-driven --json` must prove package source.
Afterward, `schema which expense-app --json` must prove the canonical project
source. The upstream schema digest is recorded. `openspec/config.yaml` selects
`expense-app`.

This integration change begins on `schema: spec-driven`; the managed schema
task migrates `.openspec.yaml` to `expense-app`. All later changes explicitly
use `--schema expense-app`.

Repository validation supplements OpenSpec with payload-level `valid: true`,
schema name/path/graph checks, safe generated paths, semantic `guard.json`,
one-to-one task policy, registered checks, canonical allowed paths, non-empty
content, full change-tree/policy digests, and rejection of symlinks or special
files.

### 5. Add a distinct planning transition

OpenSpec creates/edits planning artifacts. `pnpm workflow plan-commit
<change-id>` only validates them, proves a planning-only diff, records evidence,
stages exact paths, and commits through the existing compare-and-swap boundary.

```text
Change: <change-id>
Transition: plan
```

Plan commits cannot contain `Task`, checked tasks, implementation files,
normative specs, or archives. Revisions require no active session, invalidate
stale reports, and revalidate before another task starts.

The initial dependency-and-planning commit is a single named exception. CI
accepts it only with the exact change ID/trailers, 1.6.0 manifest and lock
delta, explicit build-script denial, and complete unchecked planning tree. It
cannot be replayed or reused.

### 6. Generate only planning-safe Codex assets

Generation runs in a fresh temporary project and isolated homes with custom
profile/delivery for exactly `explore` and `propose`:

```text
pnpm exec openspec init <temp-project> --tools codex --profile custom --force
```

Only those assets are copied. A reviewed overlay replaces bare `openspec` with
`pnpm exec openspec`, removes `/opsx:apply`, registered-store guidance,
`Bash(openspec:*)`, generic incompatible tool names, and unverified slash
syntax, then hands implementation to `pnpm workflow`. A manifest records tool
and overlay versions, expected paths, and digests; CI regeneration writes only
to temporary directories.

Repository-local `.codex/skills` becomes supported only after a real discovery
smoke test. Optional global prompts require an explicit installer, reviewed
files, exact destinations, and overwrite confirmation. Tests never depend on
global prompts.

### 7. Archive through a temporary-worktree transaction

The public authority is `pnpm workflow archive <change-id>`. It proves canonical
identity/root, strict validation, present and fully completed tasks, reachable
task commits, no active sessions, clean targets, unchanged contract/evidence,
supported file modes, and an exclusive archive lock.

The workflow resolves the absolute pinned CLI, creates a detached temporary
worktree, isolates its environment, and invokes exactly:

```text
<node> <absolute-pinned-bin> archive <change-id> --yes --json
```

Internal `--yes` is only non-interactive; it is not evidence. The adapter
validates root/change/destination/path, stages only the active deletion, exact
archive addition, and delta-named base specs, then builds a binary/full-index
patch. It verifies every ADDED/MODIFIED/REMOVED/RENAMED result, rejects silently
ignored operations such as REMOVED on a new capability, validates rebuilt
specs, records content-addressed evidence, rechecks the real fingerprint, and
applies only an exact verified patch.

```text
Change: <change-id>
Transition: archive
```

There is no synthetic task. Upstream failure remains confined to the temporary
worktree. Workflow idempotency accepts exactly one verified
`YYYY-MM-DD-<change-id>` archive; CI normalizes only the UTC date prefix during
replay while preserving identity and tree/spec digests.

Deep imports and a copied merge algorithm are rejected. If temporary worktrees
prove impossible, a different rollback design or supported upstream dry-run API
requires separate review.

### 8. Extend hooks and CI around three permanent transitions

| Kind    | Required trailers                        | Evidence                      |
| ------- | ---------------------------------------- | ----------------------------- |
| Task    | `Change: <id>` and `Task: <task-id>`     | Completion/check report       |
| Plan    | `Change: <id>` and `Transition: plan`    | Planning validation report    |
| Archive | `Change: <id>` and `Transition: archive` | Archive transformation report |

Hooks validate exact staged paths, trailer shape, report freshness,
transition-specific diff shape, and forbidden generated assets but never stage
files. The stable `workflow-assurance` CI job reconstructs facts from Git and
the pinned tools, recognizes only the named bootstrap exception, and recomputes
schema/change/guard/digest/check/transition/archive validity without trusting
local runtime reports.

Remote branch-rule changes remain a separately authorized maintainer action.

## Risks / Trade-offs

- **OpenSpec JSON or schema behavior drifts** → exact pin, typed validators,
  provenance/digest checks, fixtures, and reviewed upgrades.
- **User stores or schemas alter resolution** → isolated state plus canonical
  root/source checks.
- **Existence is mistaken for validity** → repository semantic validation for
  every artifact and guard.
- **Generated assets expose lifecycle actions** → allowlist generation,
  overlays, manifests, forbidden-reference tests, and CI drift checks.
- **Archive partially mutates files or ignores a delta** → disposable worktree,
  exact final-state comparison, fault injection, and verified patches.
- **Archive replay crosses a UTC day** → normalize only the date prefix while
  preserving identity and content digests.
- **The bootstrap exception becomes a bypass** → exact change/diff/version/
  trailer/ancestry rules and non-replay tests.
- **Codex does not discover repository skills** → treat discovery as a pilot
  gate instead of silently changing installation scope.
- **Integration complexity grows** → reuse existing locks, reports, path
  validation, checks, staging, and Git compare-and-swap primitives.

## Migration Plan

1. Commit the one authorized dependency-and-planning baseline with exact pin,
   lock resolution, build-script denial, and complete unchecked artifacts.
2. Make workflow tests caller-CWD independent, then add failing adapter tests
   and implement the pinned adapter/doctor diagnostics.
3. Add the permanent planning transition and its hook/CI verification while
   this change still uses `spec-driven` metadata.
4. Fork/validate `expense-app`, add guard, and update project config without
   editing the active change contract in the task commit.
5. Use the delivered planning transition to migrate only this change's metadata
   to `expense-app`, then integrate combined validation.
6. Generate and verify planning-only Codex assets.
7. Add sandboxed archive, fault/concurrency tests, hooks/CI, and active
   documentation.
8. After this change is merged and reachable from the configured base, run a
   separate small non-database pilot change through plan, task, commit, archive,
   and CI replay before declaring support.

All behavior follows RED → GREEN → REFACTOR. The initial dependency/planning
baseline changes no production behavior and is the sole TDD exception.

## Rollback

Before a successful pilot, revert the integration as one logical change, keep
planning artifacts readable as Markdown/JSON, do not archive partial migration,
restore schema config only through review, and do not delete user/global state.
Spectra remains retained and inactive; rollback never reactivates it.

After the pilot, OpenSpec/schema/workflow-policy changes require separate
proposals and compatibility tests.

## Implementation Constraints

- Adapt to the existing workflow package layout and reuse its Git-common
  runtime, locks, reports, path checks, and commit machinery.
- Keep `guard.json` machine-only; never accept artifact commands or lifecycle
  flags.
- Execute fixed argv without a shell and fail closed on roots, paths, modes,
  output shapes, warnings, and unexpected diagnostics.
- Do not trust exit codes, status labels, AI claims, checkboxes, hooks, or local
  reports without boundary-appropriate recomputation.
- Do not expose OpenSpec apply/sync/archive/bulk-archive interfaces or write to
  a real Codex home implicitly.
- Do not invoke Spectra or touch `OpenSpec-main/`.
- Do not write commit hashes into handoff Markdown.
- Do not run destructive API tests without an explicit disposable
  `TEST_DATABASE_URL`.
- Do not push, alter branch protection, or mutate external repository settings.

## Open Questions

- Does installed Codex discover repository-local `.codex/skills`, and what
  autocomplete syntax does it expose?
- Does temporary-worktree archive behave across all Git layouts supported by
  the engine?
- Which exact OpenSpec warning payloads and stderr diagnostics are safe to
  allow? The default is fail closed until each has a pinned fixture.
