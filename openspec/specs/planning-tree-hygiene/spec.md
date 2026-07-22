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

### Requirement: Generated OpenSpec Asset Format Scope Is Exact

The workflow-format contract assertion SHALL accept only the registered command that explicitly covers the reviewed human-maintained workflow paths and excludes the generated OpenSpec asset home. It MUST reject the former broad workflow-directory form and every other command.

#### Scenario: Asset-separated format scope is active

- **WHEN** the post-authority repository contract validates `workflow-format`
- **THEN** the exact asset-separated command passes
- **AND** generated OpenSpec assets remain outside formatting ownership

#### Scenario: Broad or otherwise drifted format scope returns

- **WHEN** `workflow-format` names the broad workflow directory, omits a required human-maintained path, includes the generated asset home, or otherwise changes
- **THEN** the repository contract fails

