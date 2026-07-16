## Context

`AGENTS.md` combines valid OpenSpec/workflow rules with retired-tool material,
gives only partial command routing, and states a hard 500-LOC rule the maintainer
has rejected. `docs/README.md` acts like a second document-structure guide rather
than an overview of the expense application.

The canonical tree is owned by `docs/DOCUMENT_STRUCTURE_GUIDE.md`.
`workflow/document-policy.json` is CI-anchored and already classifies
`docs/archive/**` as immutable. Thirty-five tracked legacy documents remain
outside the canonical tree. The local `memo/` board is privately excluded only
in one checkout, which the workflow engine intentionally does not trust.

## Goals / Non-Goals

**Goals:**

- Make `AGENTS.md` a self-contained routing guide for supported planning skills
  and every public workflow command/subcommand.
- Treat 500 LOC as a review signal, never a sufficient reason to edit source.
- Make `docs/README.md` a useful product/repository overview.
- Preserve document-policy authority byte-for-byte while using its existing
  immutable archive classification.
- Move the exact approved legacy inventory with preserved content and provenance.
- Make repository-root `memo/` ignored by Git and workflow checks.

**Non-Goals:**

- Product-code, dependency, database, or API changes.
- Rewriting history inside archived documents.
- Archiving any path in the final canonical inventory.
- Inventing unsupported skill aliases such as `spax:discuss`.

## Decisions

### 1. Document exact supported entry points

The guide names `openspec-explore` and `openspec-propose` exactly as installed.
It does not guess aliases. A decision table expands every command family printed
by the workflow CLI so an agent can select diagnostics, planning, execution,
recovery, document, issue, asset, hook, adapter, CI, and archive operations.

### 2. Make source-size guidance explicitly non-authoritative

The guide prefers focused TypeScript modules and permits 500 LOC as a cohesion
review signal. It explicitly prohibits source edits whose sole reason is file
length; a concrete behavior, ownership, testability, or maintainability objective
and normal verification are required.

### 3. Separate orientation from document governance

`docs/README.md` explains the product, implemented surfaces, current maturity,
monorepo layout, setup, safety, and canonical next links. Tree placement,
source-of-truth classes, and mutation rules remain in the structure guide.

### 4. Preserve archive provenance and anchored authority

Every approved source is renamed to
`docs/archive/legacy/<source-relative-to-docs>`. The existing
`docs/archive/**` immutable policy remains byte-identical to `main`; an ordinary
managed task does not attempt to change pinned authority.

### 5. Use one atomic managed task

The archive moves and the corresponding `workflow-format` path update must land
in the same task so no intermediate task commit refers to missing paths. Because
the task changes the `workflow-format` definition, that check is not allowed to
serve as its own pinned completion authority. Unchanged `workflow-tests`,
`workflow-lint`, and `managed-documents` provide managed evidence; after commit,
the new format command is run explicitly against the final tree before branch CI.

### 6. Track `/memo/` in `.gitignore`

The workflow engine honors repository `.gitignore` but intentionally ignores
private `.git/info/exclude`. A root-anchored rule preserves the local board
without weakening untracked detection elsewhere.

## Trust Boundaries and Failure Behavior

- Only `pnpm workflow` may validate/commit the plan or start, complete, finish,
  and commit the implementation task.
- `guard.json` allows the exact instruction, current-document, legacy-source,
  archive-destination, test, and check-registry paths needed by the migration.
- Contracts fail if `AGENTS.md` mentions retired tooling, omits a public command
  or supported skill, reinstates the hard LOC rule, or leaves legacy live trees.
- No database test is authorized. Archive moves must preserve Git blob content.
- Full branch CI must pass against the exact `main` base before any push.

## Migration Plan

1. Validate and commit this complete OpenSpec plan.
2. Start Task 1.1, establish RED contract evidence, and atomically update the
   guide, overview, memo rule, current references, archive paths, tests, and
   formatting registry.
3. Verify all 35 destination blobs match their source blobs, run the managed
   task lifecycle, run the final format command, and execute full branch CI.
4. Push and merge only after maintainer authorization. Archive the OpenSpec
   change in a separate post-merge transition.

## Open Questions

None. The maintainer supplied the requested rules and explicit archive authority;
the exact inventory and current command surface are locally discoverable.
