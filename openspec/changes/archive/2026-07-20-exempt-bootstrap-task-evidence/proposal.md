## Why

Archive eligibility and CI archive replay require exactly one canonical
workflow commit per completed task. The bootstrap change
`establish-executable-ai-workflow` completed its early tasks before that
convention existed: tasks 1.1 and 1.2 have no trailered commit at all and
task 2.1 has three, so the archive fails closed on immutable history even
though the planning tree itself is now fully canonical.

## What Changes

- Define the canonical-evidence epoch per change: a completed task is exempt
  from the exactly-one-commit requirement only when it was already completed
  in the before tree of the change's earliest canonical plan commit. Ordinary
  changes are born through plan introductions whose tasks must all be
  unchecked, so their exempt set is provably empty and the rule has no effect
  on any post-bootstrap change.
- Apply the identical derivation in live archive eligibility and CI archive
  replay. Exempt tasks with exactly one canonical commit keep full evidence
  recording and reachability checks; exempt tasks with zero or several
  contribute no task commit instead of failing.
- No configuration, no change-ID allowlist, no pinned hashes.

Non-goals: relaxing evidence for any task completed under the canonical
regime, changing task-history validation, or archiving the bootstrap change
inside this change.

## Capabilities

### New Capabilities

- `bootstrap-task-evidence`: archive transitions derive each change's
  canonical-evidence epoch from its earliest canonical plan commit and exempt
  only pre-epoch task completions from per-task commit evidence.

### Modified Capabilities

None.

## Impact

- Affected engine source: `packages/workflow-engine/src/archive-eligibility.ts`,
  `packages/workflow-engine/src/ci-archive.ts`, plus one new shared helper
  module.
- Affected tests: `archive-eligibility.integration.test.ts`,
  `ci-archive.integration.test.ts`.
- Unblocks the `establish-executable-ai-workflow` archive; no policy, check
  definition, or application changes.
