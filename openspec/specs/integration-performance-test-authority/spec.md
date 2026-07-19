# integration-performance-test-authority Specification

## Purpose
TBD - created by archiving change align-auth-integration-performance-budget. Update Purpose after archive.
## Requirements
### Requirement: One response-time authority per measured integration request

An integration test MUST enforce a measured request's response-time budget through one declared threshold. When `PerformanceAssertions.testEndpointPerformance()` receives an explicit limit, the same measurement MUST NOT be subjected to a second conflicting inline limit.

#### Scenario: Configured helper budget passes

- **WHEN** an integration request completes below the explicit limit passed to `testEndpointPerformance()`
- **THEN** the performance portion of the test passes without a second stricter assertion on the returned metric

#### Scenario: Configured helper budget fails

- **WHEN** an integration request reaches or exceeds the explicit limit passed to `testEndpointPerformance()`
- **THEN** the helper fails the test using that declared limit

### Requirement: Database-writing performance evidence uses a disposable target

Database-writing API performance tests MUST run only with an explicitly disposable database target. If no such local target is available, the managed change MUST rely on a required CI environment that provisions a disposable database and MUST remain unmerged until that check passes.

#### Scenario: No disposable local database is available

- **WHEN** the task is implemented without an explicitly disposable local `TEST_DATABASE_URL`
- **THEN** no local database-writing API test is run
- **AND** the GitHub API test job must pass before merge

#### Scenario: Disposable local database is available

- **WHEN** an explicitly disposable `TEST_DATABASE_URL` is provided
- **THEN** the targeted authentication integration test may be used as local GREEN evidence

