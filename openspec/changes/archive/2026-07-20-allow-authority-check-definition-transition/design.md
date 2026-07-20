## Context

`validateCiAuthorityCommit` loads required-check definitions from the
authority commit's parent so replay can prove which checks governed the
transition. `replayCommitSequence` then merges definitions across the range
and fails on drift, and `verifyPullRequest` compares the merged map against
the current registry. When the authority commit legitimately edits a
required check's definition, the parent-pinned record can never match the
current registry, so the pull request fails closed with
`CI_CHECK_DEFINITION_CHANGED`.

## Goals / Non-Goals

**Goals:**

- Let a validated authority commit change a required check definition and
  have replay recognize the new definition as authoritative from that commit
  onward.
- Keep every other definition-drift rejection exactly as strict.

**Non-Goals:**

- Weakening authority scope, signature, grant, or policy-transition checks.
- Allowing task commits to change definitions.

## Decisions

### Authority commits supersede definitions from their own tree

`validateCiAuthorityCommit` returns definitions read from the authority
commit's own tree for the required-check set derived from the parent policy
and guard. `replayCommitSequence` records them with supersede semantics:
they overwrite earlier entries instead of conflicting. Later task commits
already read their parents (post-authority trees), so their evidence agrees
with the superseded map, and the final current-registry comparison passes.

Alternative: skip the current-registry comparison when an authority commit
is in range. Rejected — it would stop validating every unrelated definition.

Alternative: record parent definitions and add pairwise tolerance. Rejected —
supersede-at-the-transition states the rule directly: the authority commit is
the definition authority.

## Risks / Trade-offs

- **[A malicious definition change hides in an authority commit]** → the
  authority path already requires a signed grant naming
  `workflow/checks.json`, scope-exact diffs, signatures, and attestation of
  the rebased result; the supersede only follows that fully validated path.
