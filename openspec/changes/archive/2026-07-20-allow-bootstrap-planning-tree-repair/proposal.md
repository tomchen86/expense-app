## Why

The deletion-only planning allowance unblocked retiring bootstrap noise, but
the bootstrap change `establish-executable-ai-workflow` also predates
`.openspec.yaml`, so its planning tree is incomplete by the canonical
contract. CI plan replay asserts before-tree completeness for every revision,
which fails closed with `CI_PLANNING_TREE_INVALID` before the deletion
allowance can even apply — every legal revision of the bootstrap change is
still blocked, and with it the change's archive.

## What Changes

- CI plan replay tolerates a required planning artifact missing from a
  revision's **before** tree exactly when the same revision **adds** that
  artifact (repair semantics). Any other before-tree incompleteness, and all
  after-tree incompleteness, remain rejected.
- Live planning transitions are untouched: they already require the resulting
  tree to be complete and schema-valid, which is what a repair revision
  produces.
- The bootstrap repair itself (adding `.openspec.yaml`, deleting
  `requirement-audit.md`) stays out of scope: it is an ordinary `plan-commit`
  once this change lands.

Non-goals: tolerating incomplete after trees, widening non-canonical
additions, or changing archive validation.

## Capabilities

### New Capabilities

- `planning-tree-repair`: CI plan replay accepts a revision that repairs a
  bootstrap-era planning tree by adding its missing required artifacts, while
  every other incompleteness keeps failing closed.

### Modified Capabilities

None.

## Impact

- Affected engine source: `packages/workflow-engine/src/ci-planning.ts`.
- Affected tests: `packages/workflow-engine/test/ci-planning.integration.test.ts`.
- Unblocks the `establish-executable-ai-workflow` repair revision and its
  subsequent archive; no live-transition, policy, or check definition changes.
