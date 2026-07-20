## Why

A Codex read-only review of the planning-repair diff surfaced a pre-existing
gap: `listTreeEntries` in CI plan replay parses `git ls-tree -r` output
without rejecting duplicate paths, and every downstream membership check
(`includes`, `Set`) silently collapses them. A crafted Git tree carrying two
same-named entries — buildable with `git hash-object` + `git mktree`, and a
`git fsck` error class — would satisfy the structural planning checks while
leaving which blob a path denotes ambiguous. GitHub's push-time
`receive.fsckObjects` currently blocks such trees, so this is
defense-in-depth: the engine's fail-closed guarantee should not depend on
remote host configuration.

## What Changes

- `listTreeEntries` rejects a planning tree whose recursive listing contains
  the same normalized path more than once, failing closed with
  `CI_PLANNING_TREE_INVALID` before any membership check runs.
- An integration test crafts a duplicate-entry tree with
  `git hash-object` + `git mktree` + `git commit-tree` and asserts rejection;
  unique trees are unaffected.

Non-goals: full `git fsck` of replayed commits (upstream transport duty),
deduplication or repair of ambiguous trees, and changes to any other tree
reader.

## Capabilities

### New Capabilities

- `planning-tree-integrity`: CI plan replay rejects planning trees whose
  listings are ambiguous through duplicate entries.

### Modified Capabilities

None.

## Impact

- Affected engine source: `packages/workflow-engine/src/ci-planning.ts`.
- Affected tests: `packages/workflow-engine/test/ci-planning.integration.test.ts`.
- No live-transition, policy, or check definition changes.
