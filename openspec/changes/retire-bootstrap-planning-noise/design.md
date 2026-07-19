## Context

`assertPlanningPaths` enforces a hard-coded canonical whitelist for every
planning transition and its CI replay. The bootstrap change committed
`requirement-audit.md` through bootstrap-era CI exceptions that no longer
exist, so the file is stranded: every legal mutation path is fail-closed. The
registered `workflow-format` command also names the bootstrap change
directory, and `contracts.test.ts` asserts that command byte-for-byte, which
would make the maintainer-authority `checks.json` edit fail its own required
checks in either ordering.

## Goals / Non-Goals

**Goals:**

- Provide one principled exit: deletion-only planning revisions for
  non-canonical files inside the change's own tree.
- Apply the identical rule in live transitions and historical CI replay.
- Let the later authority `checks.json` edit pass checks in both orderings via
  a dual-form contract assertion.

**Non-Goals:**

- Allowing non-canonical additions or modifications anywhere.
- Changing `checks.json` itself in this change (maintainer authority).
- Archiving the bootstrap change inside this change.

## Decisions

### Deletion-only allowance scoped to the named change tree

`assertPlanningPaths` accepts an explicit set of deleted paths. A deleted path
is exempt from the canonical whitelist only when it lies inside the named
change's own prefix. Deletions cannot introduce content, so they cannot
launder scope; canonical-artifact deletions remain guarded by artifact-graph
validation, which fails when a required artifact disappears.

Live transitions detect deletions as diff paths absent from the worktree;
CI replay detects them as paths present in the parent tree and absent from
the commit tree. Both callers pass the same explicit set; the default remains
exactly today's behavior.

Alternative: widen the whitelist with named auxiliary files. Rejected — it
invites planning-tree sprawl and retroactively blesses noise.

Alternative: an authority-grant path for planning trees. Rejected —
`openspec/changes/**` is deliberately outside authority eligibility.

### Dual-form format assertion

The contract test accepts exactly two command forms: the currently registered
`workflow-format` command, or the identical command with the
`openspec/changes/establish-executable-ai-workflow` entry removed. Any other
drift still fails. After the bootstrap change archives, a follow-up may
tighten the assertion to the single new form.

## Risks / Trade-offs

- **[Deletion allowance hides a needed artifact]** → artifact-graph
  validation still requires the complete canonical graph, so deleting a
  required artifact fails the same transition.
- **[Dual-form assertion masks unrelated drift]** → both accepted forms are
  spelled out exactly; any third form fails.
