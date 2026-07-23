# workflow-assurance Specification

## Purpose
TBD - created by archiving change establish-executable-ai-workflow. Update Purpose after archive.
## Requirements
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

### Requirement: Allowlisted Check Execution

The workflow engine SHALL execute every required check by resolving its ID from
the pinned check configuration and using only the current Node executable or a
declared workspace package bin invoked through that Node executable. It SHALL
NOT resolve bare executables from caller-controlled `PATH`, a global package
manager, a shell, interpolation, or evaluation. A non-zero exit, signal, spawn
error, or runner mutation SHALL fail verification with structured evidence.

#### Scenario: Shell syntax appears in an argument

- GIVEN a required check contains shell metacharacters in one argv element
- WHEN verification executes the check
- THEN the metacharacters are delivered as a literal argument
- AND no shell side effect occurs

#### Scenario: A required check fails

- GIVEN a required check exits non-zero
- WHEN verification runs
- THEN verification fails with the check ID and exit outcome
- AND later required checks are not reported as passing

#### Scenario: PATH contains a fake executable

- GIVEN a required check uses the `node` runner
- AND caller-controlled `PATH` points to a different executable named `node`
- WHEN verification runs
- THEN the engine uses its own `process.execPath`
- AND the PATH substitute is not executed

### Requirement: Immutable Evidence Chain

Each passing check, completion projection, finish projection, and managed
commit SHALL produce a content-addressed immutable report. A transition SHALL
validate the report digest, kind, parent, session identity, pinned contract,
Git baseline, changed paths, working-state fingerprint, and required check
evidence before relying on it.

#### Scenario: Passing report payload is replaced

- GIVEN a report ID is stored on an active session
- AND the file content no longer hashes to that ID
- WHEN the next transition is requested
- THEN the transition fails as stale state
- AND no checkbox, staging, or ref update is authorized

#### Scenario: Report omits required check evidence

- GIVEN a content-addressed report matches the current diff fingerprint
- BUT its check evidence does not contain every required ID in order
- WHEN completion or commit validation runs
- THEN the report is rejected

### Requirement: Serialized Completion Authority

Only one state-changing operation SHALL act on a session at a time. Completion
SHALL change only the exact unchecked checkbox bytes authorized by the current
passing report, and finish SHALL rerun required checks before staging exactly
the verified paths and tree.

#### Scenario: Concurrent transition is requested

- GIVEN one state-changing session operation holds the operation lock
- WHEN another check, completion, finish, commit, or abort is requested
- THEN the second operation fails with a conflict
- AND it does not overwrite report pointers or projections

#### Scenario: Existing manual staging is present

- GIVEN a completion projection has current evidence
- AND the index already contains manually staged paths
- WHEN finish is requested
- THEN finish rejects the index
- AND only an engine-controlled finish may create the staging projection

### Requirement: Atomic Managed Commit

The engine SHALL create and fully verify a commit object with the authorized
single parent, tree, changed paths, and exact canonical trailer block before it
atomically advances the current branch from the pinned baseline using a
compare-and-swap ref update. Repository hooks SHALL NOT be commit authority.

#### Scenario: Branch moves before commit authorization

- GIVEN a verified finish report pins one baseline
- AND the branch no longer points to that baseline
- WHEN commit is requested
- THEN the compare-and-swap fails
- AND the engine does not overwrite the moved branch

#### Scenario: Local commit hook is hostile

- GIVEN a repository hook exits non-zero or attempts to rewrite a message
- WHEN the engine creates an already-authorized managed commit
- THEN the engine uses Git plumbing without invoking that hook
- AND it verifies the exact commit object before updating the ref

### Requirement: Disposable Database Preflight

Before executing any destructive database check, the workflow engine SHALL
require `WORKFLOW_DISPOSABLE_DATABASE=1`, parse an explicit PostgreSQL
`TEST_DATABASE_URL`, require a disposable database-name token, reject
development/shared/staging/production identities, and reject the same
server/database identity as `DATABASE_URL`. It SHALL expose only a redacted
database identity in results and errors.

#### Scenario: One destructive check has an unsafe database

- GIVEN at least one required check is marked `destructiveDatabase`
- AND the database preflight is missing or unsafe
- WHEN verification is requested
- THEN no required check starts
- AND the failure does not reveal credentials or the raw URL

#### Scenario: Disposable database is explicitly confirmed

- GIVEN `WORKFLOW_DISPOSABLE_DATABASE=1`
- AND `TEST_DATABASE_URL` names a disposable PostgreSQL database distinct from
  `DATABASE_URL`
- WHEN verification executes destructive checks
- THEN each destructive check receives the explicit test URL
- AND evidence contains only its redacted identity

#### Scenario: Explicit test database is unavailable

- GIVEN a destructive API check receives an explicit validated
  `TEST_DATABASE_URL`
- AND that database is unavailable
- WHEN the API test harness selects its target
- THEN it fails without trying a compose, development, or auto-provisioned
  database

### Requirement: Controlled Managed-Document Mutation

Managed documents SHALL declare generated, append-only, curated, normative,
reference, or immutable mutation policy, and blocking claims SHALL only be made
after the corresponding executable validator and CI check exist.

#### Scenario: Generated issue view is edited directly

- GIVEN structured issue source and its renderer are active
- WHEN `docs/ISSUE_LOG.md` differs from deterministic rendered output
- THEN validation fails
- AND the correction must be made through an authorized issue command

### Requirement: Semantic Handoff Traceability

The current-state handoff SHALL contain exactly current change, current task,
next task, current focus, known blockers, and durable references. It SHALL NOT
store baseline, latest, or implementation commit hashes or runtime session
facts. Managed commit relationships SHALL be discoverable from Git using exact
`Change:` and `Task:` trailers.

#### Scenario: Work is handed to another agent

- GIVEN managed work has a current change and task
- WHEN a new agent reads `docs/CURRENT_AND_NEXT_STEPS.md`
- THEN it can locate the active artifacts and exact next work from semantic IDs
- AND no commit hash or copied session fact is required in the document

#### Scenario: A managed task is committed

- GIVEN current evidence authorizes a managed commit
- WHEN the commit is created
- THEN its message contains matching `Change:` and `Task:` trailers
- AND runtime status can resolve the matching commit from Git
- AND no follow-up commit is required solely to record its hash

### Requirement: Spectra Non-Participation

The repository workflow SHALL NOT invoke or depend on Spectra commands, skills,
lifecycle state, or adapters, while retained installation files MAY remain.

#### Scenario: Workflow engine runs without Spectra

- GIVEN Spectra is unavailable or unused
- WHEN workflow validation and session commands run
- THEN their behavior and authorization decisions are unchanged

### Requirement: Canonical Git Ignored-Directory Records

The workflow engine SHALL remove at most one trailing directory marker from each raw ignored-path record produced by Git before applying strict repository-path normalization. It MUST keep direct trailing-slash repository paths invalid, MUST fail closed when the decoded record remains noncanonical, and SHALL include the canonical ignored-directory path and its existing filesystem identity evidence in the working-state fingerprint.

#### Scenario: Ignored nested repository is fingerprinted

- **WHEN** Git reports a repository-ignored nested repository as `memo/`
- **THEN** the ignored-path adapter validates canonical path `memo`
- **THEN** working-state fingerprinting and change validation complete without treating the Git marker as an invalid repository path

#### Scenario: Generic repository path remains strict

- **WHEN** `memo/` is supplied directly as a generic changed repository path
- **THEN** repository-path normalization rejects it

#### Scenario: Ignored directory identity changes

- **WHEN** an ignored nested directory is removed or renamed between working-state fingerprints
- **THEN** the resulting fingerprint differs

