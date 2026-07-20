## Context

`validateCiPlanningCommit` classifies a planning commit as a revision when the
before tree is non-empty, then asserts the before tree is a complete canonical
planning tree. The bootstrap change `establish-executable-ai-workflow` was
admitted through bootstrap-era CI exceptions and lacks `.openspec.yaml`, so
its before tree can never satisfy that assertion: the noise-deletion revision
designed in `retire-bootstrap-planning-noise` fails replay before the deletion
tolerance is consulted. The deletion-allowance fixtures used complete trees
plus noise, so the gap stayed invisible until the real repair was attempted.

## Goals / Non-Goals

**Goals:**

- Let CI replay accept a revision whose before tree is missing required
  artifacts only when that same revision adds them.
- Keep every other completeness failure — before or after — failing closed.
- Leave live planning transitions untouched.

**Non-Goals:**

- Tolerating incomplete after trees anywhere.
- Widening the canonical whitelist or non-canonical additions.
- Special-casing any specific change ID.

## Decisions

### Repair tolerance derived from the commit's own diff

The revision branch computes the repaired set: required artifact paths absent
from the before tree, present in the after tree, and listed in the commit's
changed paths. `assertCompletePlanningTree` accepts this set as tolerated
missing paths for the before tree only. The after tree keeps the unmodified
assertion, so a repair revision must produce a fully canonical tree in the
same commit. Deriving the set from the commit itself means no configuration,
no change-ID allowlist, and no reachable state where an incomplete tree is
blessed without being repaired.

Alternative: an exact-commit bootstrap exception like the integration
bootstrap. Rejected — it pins hashes before the commit exists and would need
another engine change per repair.

Alternative: drop the before-tree completeness assertion. Rejected — it
retroactively blesses any historical mangling instead of only the repair.

## Risks / Trade-offs

- **[Repair could mask a truncated before tree]** → the after tree must be
  complete and canonical in the same commit, and non-canonical paths remain
  rejected, so the only reachable outcome is a canonical tree.
- **[Fixture blindness recurs]** → the RED test mirrors the real bootstrap
  shape: a before tree without `.openspec.yaml` plus a revision that adds it
  and deletes noise.
