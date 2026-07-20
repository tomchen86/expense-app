## Context

`workflow-format` was registered with an explicit path list that includes the
bootstrap change's planning tree. The tree is about to be archived, and
Prettier fails on missing paths, so the entry must be retired first. The
registry is authority data: ordinary tasks cannot modify required check
definitions, and the engine verifies that constraint at check time and in CI
replay, so the edit is a break-glass authority commit by design.

## Goals / Non-Goals

**Goals:**

- Retire exactly one path entry from the registered `workflow-format` command
  through the governed maintainer path.
- Keep every check green in both orderings via the already-landed dual-form
  contract assertion.
- Attest the rebased authority commit so base-owned replay stays green for
  every later pull request.

**Non-Goals:**

- Any other `checks.json` change, engine change, or policy change.
- Deleting the bootstrap noise file or archiving the bootstrap change here.

## Decisions

### Single-entry authority edit

The authority commit removes only the
`openspec/changes/establish-executable-ai-workflow` line. The grant names
`workflow/checks.json` as its exact path; the engine rejects any other changed
path in the authority diff.

Alternative: fold the edit into an ordinary task. Rejected — required-check
definitions are pinned authority; the engine fails closed on task-scope
changes to them, which is the invariant that makes check evidence
trustworthy.

### Handoff baseline precedes the authority session

The authority session runs every pinned normal check, including
`managed-documents`. A freshly planned change invalidates the generated
handoff, so task 1.1 refreshes it first; the authority session then evaluates
a clean baseline.

## Risks / Trade-offs

- **[Grant expiry during CI]** → the 30-minute TTL must cover the authority
  commit and the pull request's assurance run; issue the grant only when
  GitHub Actions is healthy and rerun with a fresh grant if the window closes.
- **[Unattested authority commit blocks later PRs]** → the attestation step is
  part of this change's definition of done; the next pull request stays red
  until the maintainer publishes the tag, exactly as designed.
