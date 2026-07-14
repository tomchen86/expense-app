# Delta for Workflow Assurance

## ADDED Requirements

### Requirement: Canonical Planning Artifacts

The repository SHALL use OpenSpec specs for normative requirements and one
OpenSpec change directory for each active proposal, design, delta specification,
and task list. It SHALL NOT maintain a parallel workflow planning/task tree.

#### Scenario: Agent locates active work

- GIVEN an active managed change
- WHEN an agent determines requirements, design, or remaining tasks
- THEN it reads the applicable `openspec/specs/` and
  `openspec/changes/<change-id>/` artifacts
- AND it does not infer task truth from chat history or a second planning tree

### Requirement: Blocking Session Preflight

The workflow engine SHALL refuse to create an active session unless repository
identity, branch, clean baseline, change artifacts, task policy, and exclusive
lock invariants pass.

#### Scenario: Dirty worktree is rejected

- GIVEN a valid change and task
- AND the working tree has a staged, unstaged, or untracked path
- WHEN session start is requested
- THEN the command exits with a guard failure
- AND it creates no active session or retained lock
- AND it does not stash, reset, delete, or absorb the existing work

#### Scenario: Valid baseline creates a pinned session

- GIVEN a clean worktree on the exact change branch
- AND proposal, design, delta specs, tasks, guard policy, and check IDs validate
- WHEN session start is requested
- THEN one exclusive change lock is acquired
- AND an atomic session records repository, Git, artifact digest, task scope,
  and required-check facts

### Requirement: Diff Scope Verification

The workflow engine SHALL compare changed and untracked paths with the selected
task's exact or segment-aware prefix allowlist.

#### Scenario: Out-of-scope path is detected

- GIVEN an active session for one task
- WHEN a path outside that task's allowlist changes
- THEN workflow check fails with the unexpected path
- AND the task cannot be authorized complete

### Requirement: Evidence Owns Completion

Task checkbox, completion, staging, commit, and archive transitions SHALL require
current engine evidence rather than an AI assertion or Markdown state alone.

#### Scenario: Checkbox has no matching report

- GIVEN a task checkbox is checked
- AND no current passing report matches the exact baseline and diff
- WHEN completion or CI verification runs
- THEN verification fails
- AND the checked box is treated as an invalid projection

### Requirement: Controlled Managed-Document Mutation

Managed documents SHALL declare generated, append-only, curated, normative,
reference, or immutable mutation policy, and blocking claims SHALL only be made
after the corresponding executable validator and CI check exist.

#### Scenario: Generated issue view is edited directly

- GIVEN structured issue source and its renderer are active
- WHEN `docs/ISSUE_LOG.md` differs from deterministic rendered output
- THEN validation fails
- AND the correction must be made through an authorized issue command

### Requirement: Spectra Non-Participation

The repository workflow SHALL NOT invoke or depend on Spectra commands, skills,
lifecycle state, or adapters, while retained installation files MAY remain.

#### Scenario: Workflow engine runs without Spectra

- GIVEN Spectra is unavailable or unused
- WHEN workflow validation and session commands run
- THEN their behavior and authorization decisions are unchanged
