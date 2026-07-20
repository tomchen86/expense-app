# ci-check-authority Specification

## Purpose
TBD - created by archiving change unify-format-check-authority. Update Purpose after archive.
## Requirements
### Requirement: Registered Checks Are the Sole CI Command Authority

External CI and local verification SHALL resolve a named check through the
versioned workflow check registry and execute it through the repository-owned
workflow runner. An adapter command or CI workflow MUST NOT maintain a second
command, runner, or path-scope definition for that check.

#### Scenario: GitHub runs the formatting check

- **WHEN** the GitHub formatting job invokes its local verification entry point
- **THEN** the workflow engine resolves `workflow-format` from
  `workflow/checks.json`
- **THEN** the unchanged registered command and path scope are executed

#### Scenario: Historical definition is replayed

- **WHEN** historical task evidence references `workflow-format`
- **THEN** replay continues to use the definition committed with that evidence
- **THEN** the CI adapter introduces no alternate formatting scope

### Requirement: Standalone Registered Check Execution Is Fail-Closed

The workflow CLI SHALL allow exactly one registered non-destructive check to be
executed by ID against a clean current checkout. It MUST pin the registered
runner, bind execution to current HEAD, reject unknown or destructive checks,
reject checkout mutation, and return structured evidence without granting task,
completion, staging, commit, or archive authority.

#### Scenario: Registered non-destructive check passes

- **WHEN** an operator executes a known non-destructive check in a clean checkout
- **THEN** the engine executes the registered command through its pinned runner
- **THEN** the result identifies the check, outcome, runner digest, and database
  classification

#### Scenario: Check ID is unknown

- **WHEN** standalone execution names a check absent from the registry
- **THEN** the command fails before spawning a process

#### Scenario: Check is destructive

- **WHEN** standalone execution names a check marked `destructiveDatabase`
- **THEN** the command fails without accepting database credentials or executing
  the check

#### Scenario: Checkout is dirty or mutated

- **WHEN** the checkout is dirty before execution or the check changes it
- **THEN** the command fails and produces no authoritative passing result

### Requirement: Formatting Scope Remains Historically Stable

The authority-unification migration MUST preserve the complete
`workflow-format` definition in `workflow/checks.json` byte-for-byte and MUST
NOT format, ignore, or rewrite files merely because the superseded global
Prettier invocation reported them.

#### Scenario: Migration is reviewed

- **WHEN** the repair task is compared with its planning base
- **THEN** the `workflow-format` registry definition is identical
- **THEN** generated documents and unrelated OpenSpec artifacts are unchanged

### Requirement: Registered format scope excludes archived bootstrap trees

The registered `workflow-format` check command SHALL NOT name the planning
tree of an archived change. Retiring such an entry is a maintainer authority
edit to `workflow/checks.json` through a break-glass grant, and the rebased
authority commit MUST be attested before the next pull request is evaluated.

#### Scenario: Bootstrap path is retired

- **WHEN** the maintainer authority commit removes the archived bootstrap
  planning tree from the registered command
- **THEN** the dual-form contract assertion and every registered check pass
  unchanged

#### Scenario: Ordinary task attempts the same edit

- **WHEN** an ordinary task changes a required check definition
- **THEN** the engine fails closed at check time and in CI replay

