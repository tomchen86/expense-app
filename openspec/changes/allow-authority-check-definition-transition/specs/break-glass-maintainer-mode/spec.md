## ADDED Requirements

### Requirement: Authority commits carry check-definition transitions

CI replay SHALL treat a validated authority commit whose grant covers
`workflow/checks.json` as the authoritative source of required-check
definitions from its own tree, superseding earlier recorded definitions in
the range. All other definition drift MUST still fail closed.

#### Scenario: Authority commit changes a required definition

- **WHEN** a fully validated authority commit edits a required check's
  definition and the head registry matches that edit
- **THEN** replay succeeds and reports the new definition

#### Scenario: Definition drifts without an authority transition

- **WHEN** required-check definitions differ across a range with no
  validated authority commit carrying the change
- **THEN** replay fails closed with the existing definition-drift error
