## Context

The repository workflow engine performs a pinned OpenSpec archive in a
temporary detached worktree and then strictly validates every rebuilt base
spec. The post-merge pilot reached that step and exposed three legacy files
whose content has requirements but whose introductory section is named
`Current-State Scope` instead of the schema-required `Purpose`.

The active change artifacts and the workflow engine remain the trust boundary.
OpenSpec is planning/transformation machinery only; it does not authorize task
completion, commits, or archive transitions.

## Goals / Non-Goals

**Goals:**

- Make the complete normative base-spec set pass the repository-pinned strict
  OpenSpec validation.
- Preserve every existing requirement, scenario, and scope statement.
- Add the validation to a test file already executed by the registered
  `workflow-tests` check.
- Keep the task path scope exact and database-free.

**Non-Goals:**

- Rewording or extending product requirements.
- Repairing the retained `apps/web` gitlink or legacy documentation.
- Changing OpenSpec parsing, the workflow archive implementation, or the check
  registry.
- Treating a direct OpenSpec command as completion or archive authority.

## Decisions

### Exercise the pinned adapter from the registered contract suite

Add a repository-baseline test to the existing OpenSpec adapter integration
suite, which is imported by `contracts.test.ts` and therefore executed by the
registered `workflow-tests` check. The test calls the same pinned adapter used
by the workflow engine and requires a valid result.

This is preferred over a new check ID because the pilot should repair the
baseline without expanding workflow configuration. It is preferred over a
text-only heading assertion because strict validation covers the actual
OpenSpec schema and future base specs.

### Preserve prose and requirements; rename only the invalid heading

For each of the three known invalid base specs, replace
`## Current-State Scope` with `## Purpose`. The paragraph already describes the
specification's purpose and scope, so moving or rewriting content would add
unnecessary semantic risk.

### Keep archive fail-closed

Do not weaken the archive validator or accept malformed diagnostic payloads.
The repository must become valid so the existing engine-owned transition can
complete. RED is the new registered contract failing against the old baseline;
GREEN is the same test and pinned strict validation passing after the three
heading repairs.

## Risks / Trade-offs

- **Risk: A heading-only edit is mistaken for a requirements change.** → Limit
  the diff to the three exact heading lines and verify the remaining file
  content is unchanged.
- **Risk: The contract increases workflow-test duration.** → Reuse the pinned
  adapter and one validation invocation; do not add a new workflow check.
- **Risk: Another invalid base spec appears later.** → The all-spec contract
  fails closed and reports the drift before a future archive pilot.
- **Risk: OpenSpec returns unsafe diagnostics.** → Preserve the adapter's
  strict payload validation; do not special-case or suppress diagnostics.

## Migration Plan

1. Commit this planning baseline through `workflow plan-commit`.
2. Start Task 1.1 and add the repository-baseline contract; demonstrate RED.
3. Rename the three headings and demonstrate GREEN with the targeted contract,
   the configured workflow checks, and pinned strict validation.
4. Complete and commit through the engine, merge through the active main
   ruleset, then retry the original engine-owned archive.

Rollback is a rebase PR reverting the task commit. Reverting would intentionally
restore the archive blocker and make the repository-baseline contract fail.

## Open Questions

None.
