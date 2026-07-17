## Context

`docs/CURRENT_AND_NEXT_STEPS.md` is a tracked generated projection. Its current
selector loads only directories directly below `openspec/changes/`. Once the
selected completed change moves to `openspec/changes/archive/<date>-<id>/`, the
selection disappears. If multiple incomplete changes remain, validation cannot
choose one and every normal hook fails even though Git and OpenSpec archive
evidence are valid.

The repair must remain Git-derived and portable to a fresh clone. Runtime
sessions, reports, local branch aliases, and the user's other worktrees are not
trusted archive evidence. The canonical archive patch also must remain owned by
the existing OpenSpec adapter and archive engine.

## Goals / Non-Goals

**Goals:**

- Preserve an explicitly selected completed change when its tracked contract
  moves from the active root into the archive.
- Let a matching `work/<change-id>` branch select a new active change after the
  previous selection has been archived.
- Keep the completed handoff byte-stable across the archive move.
- Fail closed for missing, unsafe, duplicate, malformed, or incomplete archived
  candidates.
- Prove the behavior without database tests or untracked runtime state.

**Non-Goals:**

- Do not choose project priority among unrelated active changes; the Roadmap
  and an explicit managed branch remain authoritative.
- Do not change OpenSpec archive output, archive commit scope, CI archive
  replay, GitHub rules, or runtime session persistence.
- Do not make archived planning artifacts editable or revive an archived change
  as an implementation target.

## Decisions

### Resolve the selected logical change from tracked active or archived state

The handoff selector will use the selected semantic change ID already stored in
the generated document. It first accepts a matching active contract. If that
active contract is absent, it may load exactly one plain archived directory
whose canonical date-and-change name matches the selected ID, parse its task
list, and require every task to be complete.

The archived reader is intentionally narrower than the executable change
contract loader: it needs only immutable semantic task titles and completion
state. It will reject symlinks, non-files, ambiguous dates, malformed tasks,
and incomplete archives. This keeps archived content read-only and prevents it
from granting task execution authority.

Alternative considered: select the first remaining active change. Rejected
because lexical filesystem order is not project priority and would silently
override `docs/ROADMAP.md`.

### Let an exact managed branch take over an archived selection

If the selected ID no longer names an active change and the current named
branch exactly matches the configured `work/<change-id>` template, a valid
active contract for that branch becomes current before the archived fallback.
This permits a newly planned repair to refresh the handoff through the normal
managed task lifecycle. Detached CI replay has no branch candidate and remains
fully tracked-state-derived.

Alternative considered: add a CLI `--change` selector. Rejected because it
would create a new hand-authored lifecycle input and complicate hook replay.

### Make completed handoff content archive-stable

Completed-change focus text will describe the absence of implementation tasks
without claiming that archival is still pending. References will point to the
stable change and base-spec roots rather than an active-only change directory
or delta path. The change ID, tasks, blockers, and six-section structure remain
semantic and hash-free.

Alternative considered: mutate the handoff inside every archive commit.
Rejected because it would expand the canonical archive patch, CI replay, and
document-policy transition when the same outcome can be achieved with a stable
logical projection.

## Risks / Trade-offs

- **[Archived selection could hide another incomplete change]** → Preserve the
  prior explicit selection only; a new exact managed branch can take ownership,
  and the Roadmap remains the source of priority.
- **[Archive directory names could collide or be forged]** → Require one exact
  canonical date/ID match, plain filesystem objects, a matching task contract,
  and all tasks complete; otherwise fail closed.
- **[Generic links lose a direct per-change shortcut]** → Keep the semantic
  change ID visible and link stable tracked roots so references remain valid on
  both sides of archive.

## Migration Plan

1. Plan-commit this repair while `add-break-glass-maintainer-mode` is still an
   active completed change and the existing handoff validates.
2. Create the canonical break-glass archive commit.
3. Implement the selector and regression tests through the repair task, then
   render the handoff inside that authorized scope.
4. Push one PR containing the repair plan, canonical archive, and repair task;
   require base-owned `workflow-assurance` to replay the complete sequence.
5. After merge, archive this repair normally. The archive-stable handoff must
   pass hooks without another repair.

Rollback before merge is branch abandonment. After merge, use a new managed
change; do not edit the generated handoff or archived artifacts manually.

## Open Questions

None.
