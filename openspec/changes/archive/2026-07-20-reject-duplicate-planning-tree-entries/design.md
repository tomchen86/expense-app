## Context

`validateCiPlanningCommit` reads before and after trees through
`listTreeEntries`, which parses `git ls-tree -r -z` output into entries and
hands their paths to membership checks. Git tolerates trees with duplicate
same-named entries when they are written directly (`git mktree` performs no
duplicate validation), and `ls-tree` emits every entry, but arrays and sets
built from the listing collapse the duplicates, so all structural assertions
pass while `git show commit:path` resolution stays ambiguous. The only thing
keeping such trees out of the repository today is GitHub's push-time fsck —
host configuration, not engine guarantee.

## Goals / Non-Goals

**Goals:**

- Reject ambiguous planning trees at the single boundary where tree listings
  enter CI plan replay.
- Keep unique-path trees byte-for-byte unaffected.

**Non-Goals:**

- Running `git fsck` over replayed commits.
- Hardening unrelated tree readers in the same pass.
- Repairing or deduplicating ambiguous trees.

## Decisions

### Reject at the parse boundary, not in the consumers

`listTreeEntries` is the one chokepoint through which every planning-tree
listing flows; a duplicate check there covers all present and future
consumers without threading tolerance flags through assertion signatures.
The check runs on normalized paths, so alias forms cannot mask a duplicate.

Alternative: deduplicate and continue. Rejected — an ambiguous tree has no
canonical reading; choosing one silently is exactly the laundering the
fail-closed contract forbids.

Alternative: verify the whole commit with `git fsck`. Rejected — replay
validates specific reconstructed facts, and object-store hygiene is the
transport's responsibility; a targeted structural check keeps the trust
surface auditable.

## Risks / Trade-offs

- **[Legitimate history contains a duplicate tree]** → the protected branch
  was always fronted by GitHub's push-time fsck, which rejects
  `duplicateEntries`, so no reachable main history can regress.
- **[Check misses non-blob duplicates]** → `ls-tree -r` expands trees to
  their blob paths; a same-named blob/tree pair yields path-prefix overlap
  rather than equal paths and already fails materialization elsewhere;
  equal-path duplicates are the ambiguity class this change closes.
