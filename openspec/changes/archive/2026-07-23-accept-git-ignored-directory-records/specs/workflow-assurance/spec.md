## ADDED Requirements

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
