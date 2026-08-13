# API Platform Specification

## Purpose

Define the NestJS cloud boundary for authenticated, explicit-space expense
collaboration and synchronization with offline-first mobile clients.

## Delivery Status

The current API implements explicit Space context, personal-ledger projection,
canonical expense validation, idempotent create, optimistic versions,
tombstones, per-currency statistics, and the incremental expense feed. The
mobile HTTP coordinator and durable inbox/outbox are not connected yet, and
refresh-token family rotation/reuse detection, logout/revocation, and
credential throttling in the security requirement below remain target behavior.

## Requirements

### Requirement: Modular API Application

The API SHALL bootstrap through NestJS and compose authentication, user,
space, category, participant, expense, and synchronization capabilities. Its
public boundary SHALL validate request DTOs and map failures to a consistent
error contract.

#### Scenario: Invalid request reaches the API

- WHEN a request violates a runtime DTO constraint
- THEN the API rejects it before domain mutation
- AND returns a stable validation error without leaking database details

### Requirement: Migration-Managed PostgreSQL Persistence

The normal runtime database SHALL be PostgreSQL with schema synchronization
disabled. Tracked migrations SHALL own schema evolution and SHALL preserve
financial history across upgrades.

#### Scenario: PostgreSQL runtime starts

- WHEN the API starts with valid database configuration
- THEN it loads tracked runtime entities and migrations
- AND TypeORM schema synchronization remains disabled

### Requirement: Explicit Space Context

Every category, participant, expense, membership, and shared-space request
SHALL identify a `spaceId` explicitly through its route or validated payload.
The API SHALL verify active membership and capability for that exact space. It
SHALL NOT infer the target from the earliest user membership. During migration,
an old-client request that omits space context MAY resolve only to the user's
unique personal space; omission SHALL never select a shared space.

#### Scenario: User selects one of several spaces

- GIVEN the user belongs to several spaces
- WHEN the client submits the validated explicit space identifier
- THEN only that explicit space is queried
- AND another membership cannot redirect the request

### Requirement: Personal Ledger Projection API

The API SHALL expose a current-user projection that combines personal-space
expenses with the user's payments and shares in authorized shared spaces. It
SHALL distinguish paid, spent, and balance values and SHALL not duplicate an
expense into a second ledger row.

#### Scenario: User consumes part of a shared expense

- GIVEN a shared expense is `10000` minor units and the user's share is `2000`
- WHEN the current-user ledger is requested
- THEN the expense appears once
- AND its `mySpent` value is `2000`

### Requirement: Atomic Expense Aggregate

Expense, payment, and share creation or allocation changes SHALL be atomic.
Canonical minor-unit payment totals and share totals SHALL each equal the
expense amount. Same-space relationships SHALL be enforced by both service
validation and database constraints.

#### Scenario: Allocation write fails

- GIVEN an expense mutation contains an invalid participant or unbalanced
  allocation
- WHEN persistence is attempted
- THEN no part of the aggregate is committed

### Requirement: Idempotent Versioned Synchronization

Syncable creates SHALL include a stable client mutation identifier. The API
SHALL deduplicate retries in the target space. Updates and deletes SHALL
include an expected record version; stale mutations SHALL return a conflict.
Deletes SHALL produce versioned tombstones available to incremental sync.

#### Scenario: Client retries a create

- GIVEN a create with the same space and mutation identifier was accepted
- WHEN it is submitted again
- THEN the API returns the existing logical record
- AND does not create a duplicate

#### Scenario: Client updates a stale version

- GIVEN the server version is newer than the client's expected version
- WHEN the update is submitted
- THEN the API returns a conflict with current version metadata

### Requirement: Incremental Sync Feed

An authorized device SHALL be able to request changes for an explicit space
after a durable cursor. The response SHALL include upserts and tombstones in a
stable order and SHALL return the next cursor. Advancing a device cursor SHALL
occur only after the client durably applies the batch.

#### Scenario: Device reconnects

- GIVEN a device has a previously acknowledged cursor
- WHEN it requests changes after that cursor
- THEN the API returns only later authorized changes
- AND includes deleted records as tombstones

### Requirement: Currency-Safe Statistics

Statistics SHALL use the requested projection and SHALL group totals by
currency unless an explicit conversion contract is supplied. The API SHALL
never add unlike minor-unit currencies into one unlabeled total.

#### Scenario: Space has multiple currencies

- GIVEN no base-currency conversion applies
- WHEN statistics are requested
- THEN each currency has a separate total

### Requirement: Account and Device Security

The API SHALL validate registration and login payloads, throttle credential
attempts, rotate refresh-token sessions with reuse detection, and permit
logout/revocation. Device records SHALL be scoped to the authenticated account
and SHALL report sync state without becoming the source of financial truth.

#### Scenario: Refresh token is reused

- GIVEN a refresh token was already rotated
- WHEN the same token is presented again
- THEN the token family is rejected or revoked
- AND no new access token is issued
