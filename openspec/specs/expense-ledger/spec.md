# Expense Ledger Specification

## Purpose

Define the current mobile expense capture, mutation, list, and user-share
behavior backed by the local Zustand ledger.

## Requirements

### Requirement: Expense Capture Fields

The mobile expense form SHALL collect a title, amount, category, and date. It
SHALL also support an optional caption and optional group assignment. When a
group is selected, the form SHALL expose payer and split-participant selection
from that group's participants.

#### Scenario: User opens a new personal expense form

- GIVEN no existing expense was supplied to the add/edit destination
- WHEN the form is initialized
- THEN title, amount, and caption are empty
- AND the date is initialized to the current date
- AND category is initialized from the first available category, falling back
  to `Other`
- AND no group, payer, or split participant is selected

#### Scenario: User selects a group

- GIVEN the expense form is open
- WHEN the user selects a group
- THEN the selected payer is cleared
- AND the selected split participants are cleared
- AND payer and split choices are limited to the selected group's participants

### Requirement: Expense Validation

The mobile expense form SHALL block submission when title, amount, date, or
category is absent. It SHALL parse the amount as a number and SHALL block a
non-numeric, zero, or negative result. A group expense SHALL additionally
require a selected payer and at least one selected split participant.

#### Scenario: A required value is absent

- GIVEN the expense form lacks title, amount, date, or category
- WHEN the user submits the form
- THEN the application displays `Please fill all required fields.`
- AND no expense is added or updated

#### Scenario: Amount is not positive

- GIVEN the supplied amount parses to a non-number, zero, or a negative number
- WHEN the user submits the form
- THEN the application displays `Amount must be a positive number.`
- AND no expense is added or updated

#### Scenario: Group allocation is incomplete

- GIVEN a group is selected
- AND either no payer or no split participant is selected
- WHEN the user submits the form
- THEN the application asks the user to select both payer and split participants
- AND no expense is added or updated

### Requirement: Expense Date Selection

The mobile expense form SHALL expose a platform date picker that displays the
selected date in `YYYY-MM-DD` form and prevents selection of a future date.

#### Scenario: User chooses an expense date

- GIVEN the expense form is open
- WHEN the user activates the date field
- THEN the platform date picker is displayed
- AND dates after the current date are unavailable

### Requirement: Personal Expense Creation

On valid personal submission, the ledger SHALL trim the title, parse and store
the numeric amount, store the selected date as the date portion of its ISO
representation, preserve a non-empty trimmed caption, and assign the internal
user identifier as both `paidBy` and `groupId`. The ledger SHALL assign a new
local expense identifier and return to the preceding screen.

#### Scenario: User creates a personal expense

- GIVEN the form contains valid required values
- AND no group is selected
- AND an internal user identifier is available
- WHEN the user submits the form
- THEN one new expense is stored with a generated identifier
- AND `paidBy` and `groupId` both equal the internal user identifier
- AND no `splitBetween` field is stored
- AND the application navigates back

### Requirement: Group Expense Creation

On valid group submission, the ledger SHALL store the selected group's
identifier, the selected payer's identifier, and the identifiers of all
selected split participants with the expense.

#### Scenario: User creates a group expense

- GIVEN the form contains valid required values
- AND a group, payer, and one or more split participants are selected
- WHEN the user submits the form
- THEN one new expense is stored for the selected group
- AND `paidBy` identifies the selected payer
- AND `splitBetween` contains the selected participants' identifiers
- AND the application navigates back

### Requirement: Existing Expense Editing

When an expense is supplied to the add/edit destination, the form SHALL load
its stored fields and enter edit mode. A valid submission SHALL replace the
expense with the submitted values while preserving its identifier.

#### Scenario: User updates an existing expense

- GIVEN the add/edit destination received a serialized existing expense
- WHEN the route value is parsed and the form is initialized
- THEN the form displays that expense's title, amount, date, category, caption,
  group, payer, and split participants when those references are available
- WHEN the user submits valid changes
- THEN the ledger updates the expense with the same identifier
- AND the application navigates back

### Requirement: Ledger Ordering

After adding or updating an expense, the ledger SHALL order stored expenses by
date in descending order.

#### Scenario: A mutation changes chronological order

- GIVEN the ledger contains expenses on different dates
- WHEN an expense is added or its date is updated
- THEN expenses with later dates precede expenses with earlier dates

### Requirement: Expense Screen Relevance and Share

The Expense screen SHALL list only expenses relevant to the internal user. An
expense is relevant when it is personal to that user, the user paid it in a
different group, or the user appears in its split participants in a different
group. The screen SHALL calculate a split expense's user share as the full
amount divided equally by the number of split participants when the user is in
that split; it SHALL use the full amount for an unsplit expense paid by the
user, and zero otherwise. `Your Total Share` SHALL be the sum of those computed
shares.

#### Scenario: Split expense includes the user

- GIVEN an expense amount is split among multiple participant identifiers
- AND the internal user identifier is included
- WHEN the Expense screen calculates the user's share
- THEN the share equals the expense amount divided by the number of split
  participants

#### Scenario: User is not involved in an expense

- GIVEN an expense is neither personal to, paid by, nor split with the internal
  user
- WHEN the Expense screen derives its list
- THEN that expense is omitted

#### Scenario: Internal user identity is unavailable

- GIVEN no internal user identifier is available
- WHEN the Expense screen derives its list and total
- THEN no expenses are listed
- AND the total share is zero

### Requirement: Expense List Presentation and Actions

Each listed expense SHALL display its title, computed display amount prefixed
with `$` and rounded to two decimal places, category name, and date. It SHALL
also display a known non-personal group tag, resolved payer name, and caption
when those values are available. Each item SHALL expose explicit `Edit` and
`Delete` controls; deletion SHALL require confirmation before removing the
expense by identifier.

#### Scenario: User edits a listed expense

- GIVEN an expense appears on the Expense screen
- WHEN the user activates its `Edit` control
- THEN the application pushes `/add-expense`
- AND the route includes the serialized expense to edit

#### Scenario: User confirms deletion

- GIVEN an expense appears on the Expense screen
- WHEN the user activates `Delete` and confirms the destructive action
- THEN the ledger removes the expense with that identifier

#### Scenario: User cancels deletion

- GIVEN the deletion confirmation is visible
- WHEN the user selects `Cancel`
- THEN the expense remains in the ledger
