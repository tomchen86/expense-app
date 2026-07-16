# Group Collaboration Specification

## Purpose

This specification records the independent mobile in-memory group model and
authenticated API ledger model that exist today. It does not assert mobile/API
synchronization, owner-only group mutation, an explicit leave-group flow, or
durable persistence.

## Requirements

### Requirement: Mobile Group Creation Prerequisite

The mobile Group tab SHALL require a non-empty session display name before it
opens the group-creation form. A created local group SHALL have a generated
identifier and creation timestamp and SHALL include the current user's local
participant record when that record can be resolved.

#### Scenario: User has not supplied a display name

- GIVEN the mobile session has no non-empty display name
- WHEN the user requests a new group
- THEN the app reports that a username is required
- AND offers navigation to Settings instead of opening the creation form

#### Scenario: Named user creates a group

- GIVEN the mobile session has a non-empty display name
- WHEN the user submits a non-empty group name
- THEN a local group is created with that name, an identifier, and a timestamp
- AND the current user's participant is included in the group

#### Scenario: User submits an empty group name

- GIVEN the group-creation modal is open
- WHEN the user submits an empty or whitespace-only group name
- THEN the app presents its input-required alert
- AND no local group is created

### Requirement: Mobile Group List and Membership Controls

The mobile Group tab SHALL list each local group with its name, total expense
amount, and current participant names. It SHALL allow local participants to be
added or removed and SHALL ask for confirmation before deleting a group.
Confirming local group deletion SHALL remove that group and its associated
group identifier from local expenses while preserving those expense records.

#### Scenario: User adds a participant

- GIVEN a local group is listed
- WHEN the user submits a non-empty participant name that can be added to the
  local participant store
- THEN that participant appears in the group's participant list

#### Scenario: User removes a participant from one group

- GIVEN a participant is in a local group
- WHEN the user confirms removal from that group
- THEN the participant is removed from that group's participant list
- AND the participant remains available in the global local participant store

#### Scenario: User deletes a local group

- GIVEN a local group has associated local expenses
- WHEN the user confirms deletion of the group
- THEN the group is removed from the local group list
- AND expenses that used that group identifier remain in the local expense
  store with their `groupId` cleared

### Requirement: Mobile Group Expense Detail

The mobile group-detail surface SHALL show the selected group's total, the
current user's amount paid in that group, and the expense feed filtered by the
group identifier. It SHALL provide navigation to group insights and an
add-expense flow preselected for the group.

#### Scenario: User opens a group

- GIVEN a local group exists with expenses
- WHEN the user opens that group
- THEN the detail surface sums amounts for expenses with that group identifier
- AND lists only those expenses
- AND the displayed current-user contribution sums expenses paid by the
  current user's local identifier

#### Scenario: Group identifier is unknown

- GIVEN the requested group identifier is not in the local group store
- WHEN the group-detail surface loads
- THEN the app reports that the group was not found

### Requirement: Mobile Group Balance Projection

The mobile balance overlay SHALL show, for every current group participant,
the total paid, total allocated share, and net balance. An expense SHALL use
its participant snapshot when one exists; otherwise its amount SHALL be split
equally across the group's current participants for this projection.

#### Scenario: Expense has no participant snapshot

- GIVEN a group expense identifies a payer but has no populated `participants`
  snapshot
- WHEN the balance overlay is opened
- THEN the payer's total paid includes the expense amount
- AND the expense amount is allocated equally across the group's current
  participants
- AND each displayed net balance is total paid minus total share

### Requirement: API Ledger Participants

The API SHALL allow an authenticated user to list, create, update, and soft
delete participants only within that user's ledger. It SHALL reject duplicate
non-empty participant email addresses within the ledger, SHALL reject
participant identifiers from another ledger, and SHALL prevent the requesting
user from deleting their own ledger participant.

#### Scenario: User creates an API participant

- GIVEN an authenticated user and an optional email not used by an active
  participant in the ledger
- WHEN the user submits a non-empty participant name
- THEN the API creates an unregistered participant in that ledger
- AND applies the submitted or default currency and notification preferences

#### Scenario: User deletes another participant

- GIVEN an active participant belongs to the user's ledger and is not the
  user's own participant
- WHEN the authenticated user requests deletion
- THEN the API soft deletes the participant
- AND marks that participant's group memberships as left

#### Scenario: User attempts self removal

- GIVEN the target participant represents the requesting user
- WHEN deletion is requested
- THEN the API rejects the request with `CANNOT_REMOVE_SELF`

### Requirement: API Group Creation

The API SHALL create a group only for an authenticated user's ledger and only
from participant identifiers that belong to that ledger. Creation SHALL
require at least one submitted participant identifier, add the requesting
user's participant if necessary, assign that participant the `owner` role,
and assign other participants the `member` role.

#### Scenario: User creates an API group

- GIVEN an authenticated user and at least one active participant identifier
  from the same ledger
- WHEN the user submits a non-empty group name and those participants
- THEN the API creates an active group in the user's ledger
- AND returns the owner participant and requested participants
- AND defaults the group's currency to `USD`

#### Scenario: Participant belongs elsewhere

- GIVEN a submitted participant identifier is not an active participant in
  the requesting user's ledger
- WHEN the user attempts to create or update a group with that identifier
- THEN the API rejects the request with `INVALID_PARTICIPANTS`

### Requirement: API Group Listing and Mutation

The API SHALL list non-deleted groups in the authenticated user's ledger in
newest-first order with their active participants. It SHALL allow group name,
description, color, and participant membership to be updated within that
ledger, while retaining the requesting user's participant as owner.

#### Scenario: User updates group membership

- GIVEN an active group and active participants belong to the user's ledger
- WHEN the authenticated user submits the desired participant identifiers
- THEN requested memberships become active
- AND omitted non-owner memberships become left
- AND the requesting user's participant remains active with the owner role

#### Scenario: User lists API groups

- GIVEN the user's ledger has active and soft-deleted groups
- WHEN the authenticated user lists groups
- THEN only non-deleted groups are returned
- AND each group includes its active participant representations

### Requirement: API Group Archival

Deleting an API group, or updating it with `isArchived: true`, SHALL mark the
group archived and soft deleted. Deletion SHALL also mark all of that group's
memberships as left, and later list operations SHALL omit the group.

#### Scenario: User deletes an API group

- GIVEN an active group belongs to the authenticated user's ledger
- WHEN deletion is requested
- THEN the API returns no response body
- AND marks the group archived and soft deleted
- AND marks its memberships as left
- AND the group is absent from subsequent list responses
