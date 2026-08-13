# Expense Ledger Specification

## Purpose

Define the canonical expense model shared by the mobile client and cloud API.
An expense is one logical record even when it has both an on-device replica and
a cloud replica. Personal and shared expenses use the same money, allocation,
identity, and history rules.

## Requirements

### Requirement: Canonical Money and Date Values

Every expense SHALL store its amount as positive integer minor units together
with an ISO 4217 currency code. An expense date SHALL be a calendar date in
`YYYY-MM-DD` form and SHALL NOT be derived by converting local midnight through
UTC. User-entered decimal amounts SHALL be validated in full and converted to
minor units before the expense is created.

#### Scenario: User enters a valid amount

- GIVEN the selected currency has two fractional digits
- WHEN the user submits `12.34`
- THEN the canonical expense amount is `1234` minor units
- AND both local and cloud representations retain the same value

#### Scenario: User enters an invalid amount

- GIVEN the amount contains trailing characters, is non-finite, has unsupported
  precision, is zero, or is negative
- WHEN the user submits the form
- THEN no expense is created
- AND the client identifies the amount as invalid

#### Scenario: User selects a local calendar date

- GIVEN the device timezone is ahead of UTC
- WHEN the user selects a calendar date
- THEN the stored `YYYY-MM-DD` value equals the date shown in the picker

### Requirement: Expense Space

Every expense SHALL belong to exactly one explicit space. A space SHALL have
kind `personal` or `shared`. A personal expense SHALL belong to the current
user's personal space; a collaborative expense SHALL belong to the selected
shared space. A user identifier SHALL NOT be stored as a fake group or space
identifier.

#### Scenario: User creates a personal expense

- GIVEN the user submits a valid expense without selecting a shared space
- WHEN the expense is created
- THEN it belongs to that user's personal space
- AND no synthetic `groupId = userId` association is created

#### Scenario: User creates a shared expense

- GIVEN the user is an active member of a shared space
- WHEN the user submits an expense for that space
- THEN the expense belongs to that exact shared space
- AND it is visible only through users authorized for that space

### Requirement: Explicit Payments and Shares

An expense SHALL record who paid through one full-amount payment allocation and
who consumed the expense through one or more share allocations. Payment and
share amounts SHALL use integer minor units. The payment and share totals SHALL
each equal the expense amount. Supporting several payers for one expense is an
explicit future extension, not part of this base contract. Participant
membership changes SHALL NOT rewrite historical allocations.

#### Scenario: Personal expense allocation

- GIVEN a personal expense amount is `1500` minor units
- WHEN it is created
- THEN the current user's payment allocation is `1500`
- AND the current user's share allocation is `1500`

#### Scenario: One user pays for several people

- GIVEN one participant pays `10000` minor units
- AND the submitted shares are `2000`, `3000`, and `5000`
- WHEN the shared expense is accepted
- THEN the payer need not be one of the consuming participants
- AND payments and shares each total `10000`

#### Scenario: Equal split has a remainder

- GIVEN `1000` minor units are split equally among three participants
- WHEN allocations are generated
- THEN the generated shares are deterministic integer values
- AND they total exactly `1000`

### Requirement: One Allocation Source of Truth

Canonical share amounts SHALL be the source of truth for balances. Equal,
percentage, or shares-based split methods MAY be accepted as user input, but
the implementation SHALL derive canonical minor-unit shares and SHALL NOT
persist contradictory percentage and amount truths.

#### Scenario: Percentage input is converted

- GIVEN a valid percentage split totals 100 percent
- WHEN the expense is created
- THEN the implementation derives deterministic minor-unit shares
- AND later balance calculations use those shares

#### Scenario: Client supplies contradictory values

- GIVEN submitted percentages and submitted minor-unit shares describe
  different allocations
- WHEN the API validates the mutation
- THEN it rejects the mutation or ignores the non-canonical derived values
- AND it never stores both as contradictory truths

### Requirement: Personal Ledger Projection

The personal expense feed SHALL be a projection, not a duplicate collection.
It SHALL include expenses in the user's personal space and shared-space
expenses for which the user has a payment or share allocation. For each
expense, `mySpent` SHALL equal the user's shares, `myPaid` SHALL equal the
user's payments, and `myBalance` SHALL equal `myPaid - mySpent`.

#### Scenario: Friend pays for the user

- GIVEN a friend pays `10000` minor units for a shared expense
- AND the current user's share is `2000`
- WHEN the current user opens the personal ledger
- THEN that one shared expense appears in the feed
- AND `mySpent` is `2000`
- AND no second copy of the expense is created

#### Scenario: User pays on behalf of others

- GIVEN the current user pays `10000` minor units
- AND the current user's own share is `2000`
- WHEN personal totals are calculated
- THEN `myPaid` is `10000`
- AND `mySpent` is `2000`
- AND `myBalance` is `8000`

### Requirement: Historical Integrity

Expense payments and shares SHALL remain resolvable after a participant leaves
a shared space or is deactivated. Removing a current membership SHALL affect
future selection only. Deleting an expense SHALL create a tombstone for sync;
it SHALL NOT silently mutate unrelated historical expenses.

#### Scenario: Participant leaves a shared space

- GIVEN a participant appears in an existing expense allocation
- WHEN that participant leaves the shared space
- THEN the existing payment and share amounts remain unchanged
- AND current member selectors omit that participant for new expenses

### Requirement: Versioned Expense Mutation

Each syncable expense SHALL have a stable client-generated identifier and a
monotonically increasing version. Retried creates SHALL be idempotent. An
update based on a stale version SHALL return a conflict rather than silently
overwriting a newer mutation.

#### Scenario: Create is retried after a timeout

- GIVEN the cloud already accepted a mutation identifier
- WHEN the client retries the same create
- THEN the API returns the same logical expense
- AND no duplicate expense is created

#### Scenario: Two devices edit the same expense

- GIVEN device A has already advanced an expense version
- WHEN device B submits an update using the previous version
- THEN the cloud rejects it as a conflict
- AND returns the current server version for deterministic reconciliation

### Requirement: Expense Presentation

The client SHALL format money using the expense currency rather than a
hard-coded symbol. Category, payer, space, notes, and date SHALL be rendered
from stable identifiers and canonical values when available.

#### Scenario: Expense uses Australian dollars

- GIVEN an expense currency is `AUD`
- WHEN it is displayed
- THEN formatting uses the configured locale and `AUD`
- AND the display does not assume that `$` uniquely means USD
