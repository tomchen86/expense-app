# planning-tree-hygiene Specification

## Purpose
TBD - created by archiving change retire-bootstrap-planning-noise. Update Purpose after archive.
## Requirements
### Requirement: Planning transitions may delete non-canonical tree noise

A planning transition SHALL accept the deletion of a non-canonical file that
lies inside the named change's own tree. Additions or modifications of
non-canonical files MUST remain rejected, and deletions outside the named
change tree MUST remain rejected. CI plan replay MUST apply the identical
rule.

#### Scenario: Noise file is deleted

- **WHEN** a planning diff deletes a non-canonical file inside the named
  change's tree and the remaining artifact graph validates
- **THEN** the planning transition and its CI replay accept the diff

#### Scenario: Noise file is added or modified

- **WHEN** a planning diff adds or modifies a non-canonical file
- **THEN** the transition fails closed with the invalid paths named

#### Scenario: Deletion escapes the change tree

- **WHEN** a planning diff deletes a file outside the named change's tree
- **THEN** the transition fails closed

### Requirement: Bootstrap format scope retirement is transition-tolerant

The workflow-format contract assertion SHALL accept exactly the currently
registered command or the identical command without the archived bootstrap
path entry, and MUST reject every other form.

#### Scenario: Authority edit retires the bootstrap path

- **WHEN** `checks.json` drops the archived bootstrap directory from the
  registered workflow-format command
- **THEN** the contract test passes without modification

#### Scenario: Any other command drift

- **WHEN** the registered workflow-format command changes in any other way
- **THEN** the contract test fails

