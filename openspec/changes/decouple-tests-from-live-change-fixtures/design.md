## Context

When `integrate-openspec-with-workflow` was implemented, its own planning
artifacts were the most convenient real-world fixture, so several integration
tests validate the pinned OpenSpec adapter and the managed change contract
directly against that live change. The repository has since gained an archive
transition, and archiving that change moves its directory to
`openspec/changes/archive/2026-…/`, deleting the fixture the tests read.
PR #62 demonstrated the consequence: the archive commit is valid, but
`workflow-tests` fails with 7 errors, so `workflow-assurance` fails closed and
the archive cannot merge.

## Goals / Non-Goals

**Goals:**

- Make the adapter and managed-contract suites pass on any tree state:
  change active, change archived, or no active change at all.
- Keep the real pinned OpenSpec CLI in the loop for the adapter test; the
  point of that test is end-to-end validation of the pinned binary.
- Keep every behavioral assertion the suites make today.

**Non-Goals:**

- Changing adapter, contract, schema, or archive behavior.
- Building a general fixture library beyond what these two suites need.
- Archiving the blocked change inside this change.

## Decisions

### Build synthetic change fixtures in temporary repositories

The rewritten tests scaffold a minimal valid change (`.openspec.yaml`,
`proposal.md`, `design.md`, `tasks.md`, `guard.json`, one delta spec) inside a
temporary fixture repository and point the adapter and contract loaders at it.
The suites already construct temporary repositories for their negative cases,
so this extends an existing pattern rather than inventing one.

Alternative: read the archived copy under `openspec/changes/archive/…`.
Rejected because the archive path embeds the archive date, the archive is an
immutable historical record rather than a test fixture, and the dependency on
repository state would remain.

Alternative: retarget the tests at another live change. Rejected because every
live change must eventually archive; the trap would only move.

### Treat the recorded CI failure as RED evidence

The rewrite is behavior-preserving for the engine, so the failing state that
motivates it is the archive tree, not the current tree. The PR #62
`workflow-assurance` failure and the local 7-failure reproduction on the
archive commit are recorded as the RED evidence; GREEN is the same suites
passing both on the current tree and on a locally constructed archive tree.

## Risks / Trade-offs

- **[Synthetic fixture drifts from the real schema]** → the adapter test still
  runs the real pinned OpenSpec CLI with the repository's `expense-app`
  schema, so an invalid fixture fails loudly.
- **[Hidden dependencies remain]** → `grep` over the test tree for the change
  ID plus a full-bundle run on the archive tree gate completion.
