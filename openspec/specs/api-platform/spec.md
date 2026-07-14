# api-platform Specification

## Purpose

Define the repository's current API platform contract: a modular NestJS
application backed by migration-managed relational data, authenticated HTTP
endpoints, and ledger-scoped expense collaboration resources.

## Requirements

### Requirement: Modular API application

The API application SHALL bootstrap through NestJS and SHALL compose
authentication, user, category, participant, group, and expense modules through
the root application module.

#### Scenario: Start the API application

- **WHEN** the API process starts with a valid database configuration
- **THEN** NestJS creates the root application and listens on the configured
  port, defaulting to port 3000
- **AND** the root module makes the implemented domain modules available

### Requirement: Migration-managed PostgreSQL persistence

The API SHALL use PostgreSQL as its normal runtime database and SHALL keep
schema synchronization disabled for PostgreSQL so that tracked migrations own
schema evolution.

#### Scenario: Configure a PostgreSQL runtime

- **WHEN** the database driver is PostgreSQL
- **THEN** the API loads its runtime entities and tracked migrations
- **AND** it enables migration execution without TypeORM schema synchronization

### Requirement: Seeded baseline data

The API repository SHALL provide repeatable seed implementations for default
categories, default user settings, and representative sample data.

#### Scenario: Prepare a new ledger baseline

- **WHEN** the relevant seed is run against an eligible database
- **THEN** the corresponding baseline records are created without requiring
  hand-entered application data

### Requirement: Account authentication endpoints

The API SHALL provide account registration, login, refresh-token, and current
user endpoints. Registration SHALL hash the submitted password and initialize
user settings, and protected endpoints SHALL resolve the authenticated user
from an access token.

#### Scenario: Register an account

- **WHEN** a client submits a unique email, password, and display name
- **THEN** the API creates the user and initial settings
- **AND** it returns an access token and a refresh token

#### Scenario: Reject invalid credentials

- **WHEN** a client submits an unknown email or an incorrect password
- **THEN** the API rejects the login without exposing which credential failed

### Requirement: User settings and device resources

Authenticated users SHALL be able to read and update their profile and
settings, select a supported persistence-mode value, and register, list,
update, or remove their device records.

#### Scenario: Change persistence preference

- **WHEN** an authenticated user selects `local_only` or `cloud_sync`
- **THEN** the API stores that preference and records the change time

### Requirement: Ledger-scoped expense resources

The API SHALL provide authenticated expense create, read, update, delete,
statistics, and paginated list operations. Expense reads and mutations SHALL
be scoped to the authenticated user's ledger.

#### Scenario: Query expenses

- **WHEN** an authenticated user lists expenses with supported pagination,
  category, participant, date, amount, or keyword filters
- **THEN** the API returns only matching expenses from that user's ledger
- **AND** the result includes pagination metadata

#### Scenario: Create a split expense

- **WHEN** an authenticated user submits a positive cent amount, currency,
  expense date, payer, and valid split data for ledger-owned resources
- **THEN** the API stores the expense and its splits atomically

### Requirement: Participant and group resources

The API SHALL provide authenticated participant and group list, create,
update, and delete operations scoped to the authenticated user's ledger.
Creating a group SHALL record its creator and establish active member records.

#### Scenario: Create a group

- **WHEN** an authenticated user submits a non-empty group name and valid
  participant identifiers from the user's ledger
- **THEN** the API creates the group
- **AND** it records the user's participant as an owner member

#### Scenario: Remove a group

- **WHEN** an authenticated user in the ledger deletes an existing group
- **THEN** the API soft-deletes the group and marks its memberships as left

### Requirement: Category resources and usage integrity

The API SHALL provide authenticated category list, create, update, and delete
operations, SHALL expose the built-in category definitions, and SHALL reject
deletion of a category referenced by a non-deleted expense.

#### Scenario: Reject deletion of an in-use category

- **WHEN** an authenticated user tries to delete a category used by an active
  expense
- **THEN** the API rejects the operation with a category-in-use error
