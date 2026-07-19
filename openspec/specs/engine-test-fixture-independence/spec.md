# engine-test-fixture-independence Specification

## Purpose
TBD - created by archiving change decouple-tests-from-live-change-fixtures. Update Purpose after archive.
## Requirements
### Requirement: Engine tests are independent of mutable planning state

Workflow-engine test suites MUST NOT read an active repository change under
`openspec/changes/` as a test fixture. Suites that validate change-shaped
inputs MUST construct synthetic fixtures in temporary repositories.

#### Scenario: Fixture change is archived

- **WHEN** any repository change completes its lifecycle and its directory
  moves to the archive container
- **THEN** every registered engine test suite still passes without
  modification

#### Scenario: No active change exists

- **WHEN** the repository has zero active changes
- **THEN** the adapter and managed-contract suites still construct and
  validate their own synthetic change fixtures

### Requirement: Pinned adapter validation stays end-to-end

The adapter suite MUST continue to execute the real pinned OpenSpec CLI
against a schema-valid synthetic change so that package, schema, status, and
change validation remain covered end to end.

#### Scenario: Synthetic change violates the schema

- **WHEN** the synthetic fixture omits a required artifact or breaks the
  repository schema
- **THEN** the pinned CLI validation fails and the test surfaces the exact
  diagnostic

