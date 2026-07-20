# planning-tree-repair Specification

## Purpose
TBD - created by archiving change allow-bootstrap-planning-tree-repair. Update Purpose after archive.
## Requirements
### Requirement: CI replay accepts bootstrap planning-tree repair revisions

CI plan replay SHALL tolerate a required planning artifact missing from a
revision's before tree only when the same revision adds that artifact, and
the resulting tree MUST satisfy the unmodified canonical completeness
contract. Every other before-tree or after-tree incompleteness MUST keep
failing closed.

#### Scenario: Repair revision adds the missing artifact

- **WHEN** a revision's before tree lacks a required planning artifact and
  the revision adds it while the resulting tree is complete and canonical
- **THEN** CI plan replay accepts the revision

#### Scenario: Repair combines with noise deletion

- **WHEN** a repair revision also deletes a non-canonical file inside the
  named change's own tree
- **THEN** CI plan replay accepts the revision under the existing
  deletion-only allowance

#### Scenario: Before tree stays incomplete

- **WHEN** a revision's before tree lacks a required planning artifact and
  the revision does not add it
- **THEN** CI plan replay fails closed

#### Scenario: After tree is incomplete

- **WHEN** any revision produces a tree missing a required planning artifact
- **THEN** CI plan replay fails closed

