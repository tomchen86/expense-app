# Group Collaboration Specification

## Purpose

Define shared expense spaces used by couples, friends, households, and trips.
`Couple` MAY remain temporarily as a legacy persistence name, but it SHALL NOT
be the universal product label or domain boundary. Mobile and API SHALL operate
on the same space, membership, participant, expense, and allocation identities.

## Delivery Status

The current API can list/create shared Spaces, add an existing account as an
active member, return its per-space Participant, and enforce owner-only storage
policy. Mobile creates durable local shared-Space identities and projections.
Invitation issue/acceptance, role changes, explicit leave/remove, Space
archival, and authenticated mobile transport remain target behavior below and
are not claims about the current routes.

## Requirements

### Requirement: Personal and Shared Spaces

Every registered user SHALL have exactly one personal space and MAY belong to
multiple shared spaces. Every request and mutation SHALL identify its target
space explicitly; an implementation SHALL NOT choose a space by taking the
user's earliest membership. A bounded old-client compatibility path MAY treat
an omitted space as the user's unique personal space, never as a shared space.

#### Scenario: User has several spaces

- GIVEN a user owns one personal space and belongs to two shared spaces
- WHEN the client creates an expense for one selected shared space
- THEN that exact space receives the expense
- AND membership creation order has no effect on routing

#### Scenario: User opens the personal ledger

- GIVEN the user has personal and shared expenses
- WHEN the personal ledger projection is requested
- THEN it combines the personal-space expenses with the user's allocations in
  authorized shared spaces
- AND it does not expose unrelated expenses from those spaces

### Requirement: Shared Space Membership

A shared space SHALL maintain account membership with role `owner` or `member`
and status `invited`, `active`, `left`, or `removed`. Invitations SHALL target
a stable account identity or an email awaiting account linkage. An active
member SHALL be represented by a participant usable in payments and shares.

#### Scenario: Invitee joins a shared space

- GIVEN a pending invitation belongs to an authenticated account or its
  verified email
- WHEN the invitee accepts it
- THEN the account becomes an active space member
- AND its participant is linked to that account

#### Scenario: Guest participates without an account

- GIVEN an active member adds a guest participant
- WHEN an expense is allocated to the guest
- THEN the guest is represented by a stable participant identifier
- AND a later account link preserves historical allocation identity

### Requirement: Shared Space Authorization

Every shared-space operation SHALL verify active space membership. Owner-only
operations SHALL include managing invitations, changing roles, archiving the
space, and changing its storage policy. Expense mutation SHALL follow an
explicit capability policy that distinguishes create, edit-own, edit-any, and
delete permissions. Merely belonging to the same space SHALL NOT grant every
mutation capability.

#### Scenario: Non-member uses a known identifier

- GIVEN a user knows a shared-space or expense identifier but is not an active
  member
- WHEN the user reads or mutates that resource
- THEN the API rejects the operation without revealing private contents

#### Scenario: Member attempts an owner action

- GIVEN an active member is not an owner
- WHEN that member tries to remove another member or archive the space
- THEN the API rejects the operation

### Requirement: Shared Space Expense Participants

Payments and shares on a shared expense SHALL reference participants belonging
to the same space. New expenses SHALL use active participants. The database
SHALL enforce same-space relationships in addition to application validation.

#### Scenario: Participant belongs to another space

- GIVEN a participant belongs to shared space B
- WHEN a client submits that participant in an expense for shared space A
- THEN the mutation is rejected
- AND no cross-space relationship is stored

### Requirement: Mobile Group Surfaces

The mobile product MAY label shared spaces as groups. Group list, detail,
balance, invitation, and expense-entry surfaces SHALL use the canonical shared
space identifier. Starting expense capture from a group detail SHALL preselect
that shared space.

#### Scenario: User adds from group detail

- GIVEN the user is viewing a known shared space
- WHEN the user activates add expense
- THEN the form opens with that shared space selected
- AND payer and share choices come from its active participants

The mobile product label `Group` SHALL map to a shared `Space`. It SHALL NOT be
mapped to the API's optional `ExpenseGroup` collection nested inside a space.
If nested collections remain supported, clients SHALL carry their identifier
separately from `spaceId`.

#### Scenario: Mobile group is synchronized

- GIVEN a mobile Group represents a trip shared by several accounts
- WHEN the client creates or resolves its cloud counterpart
- THEN it uses the shared Space API and preserves the Group ID as `spaceId`
- AND it does not create an `ExpenseGroup` under an unrelated personal space

### Requirement: Historical Membership Integrity

Leaving or removing a member SHALL deactivate current membership without
deleting historical participants, payments, or shares. Historical records
SHALL preserve display information needed to explain prior balances.

#### Scenario: Member leaves after a trip

- GIVEN the member has payment or share allocations in existing expenses
- WHEN the member leaves the shared space
- THEN those allocations and balances remain unchanged
- AND the member is unavailable for new expense allocation

### Requirement: Shared Spaces Require Cloud Sync

A shared space SHALL use cloud synchronization because multiple devices and
accounts must converge on the same records. Every accepted cloud mutation
SHALL be replicated into each participating device's local store through the
sync protocol. Temporary loss of connectivity SHALL NOT block local capture by
an authorized, previously hydrated member.

#### Scenario: Member creates an expense offline

- GIVEN the member has a hydrated shared space but no network connection
- WHEN the member creates a valid expense
- THEN the client commits it to local durable storage
- AND queues a cloud mutation
- WHEN connectivity returns
- THEN the same logical expense is synchronized without duplication

### Requirement: Shared Space Archival

Only an owner SHALL archive a shared space. Archival SHALL prevent new
expenses and membership changes while retaining historical expenses and
allocations for authorized members.

#### Scenario: Owner archives a shared space

- GIVEN a shared space contains historical expenses
- WHEN an owner archives it
- THEN new mutations are rejected
- AND authorized members can still inspect its history
