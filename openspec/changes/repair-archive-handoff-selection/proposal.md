## Why

The `add-break-glass-maintainer-mode` archive proved that a canonical archive
commit cannot pass the repository hooks when the generated handoff selects the
archived change and more than one other active change exists. The handoff
selector ignores tracked archived contracts, so fresh clones and repositories
with multiple planned changes fail with `HANDOFF_CHANGE_AMBIGUOUS` even though
the archive and task evidence are valid. This blocks the Roadmap's repository
workflow adoption and required archive-PR proof.

## What Changes

- Make the generated handoff preserve a selected completed change across its
  engine-owned move from the active change root to the tracked archive.
- Resolve the current `work/<change-id>` branch when a new active change must
  take ownership from an already archived selection.
- Keep completed-change focus text and references valid before and after
  archive so the canonical archive patch does not need a second document
  mutation.
- Add regression coverage for a fresh clone with multiple active changes,
  archived selection, and subsequent managed-change takeover.
- Keep archive commit generation, OpenSpec delta promotion, runtime sessions,
  remote rules, product code, and database behavior unchanged.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `repository-governance`: Require the generated semantic handoff and hooks to
  remain deterministic when the selected completed change is archived while
  other active changes coexist.

## Impact

The repair is limited to workflow-engine handoff selection/rendering, its
integration tests, and the generated handoff projection. It adds no dependency,
API, mobile, web, database, GitHub-ruleset, archive-patch, or product behavior.
