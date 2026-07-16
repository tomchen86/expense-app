# Category Management Specification

## Purpose

This specification records the category behavior that exists today. The mobile
in-memory catalog and the authenticated API ledger catalog are separate
surfaces; no synchronization or identifier parity between them is implied.

## Requirements

### Requirement: Mobile Default Category Catalog

Each new mobile category-store instance SHALL initialize with the eight local
categories `Food & Dining`, `Transportation`, `Shopping`, `Entertainment`,
`Bills & Utilities`, `Health`, `Travel`, and `Other`, including a color for each
category.

#### Scenario: Mobile category store initializes

- GIVEN a new mobile category-store instance
- WHEN its initial category state is read
- THEN all eight local default categories are available
- AND `Other` is available as the fallback category

### Requirement: Mobile Category Management

The mobile Manage Categories surface SHALL list the current local catalog and
allow a user to add and edit category names and colors. An add operation SHALL
trim the submitted name, reject an empty name, and reject a case-insensitive
duplicate name. The form SHALL offer the implemented twelve-color palette.

#### Scenario: User adds a unique category

- GIVEN the Manage Categories surface is open
- WHEN the user submits a non-empty name that does not duplicate a current name
- AND selects a color from the palette
- THEN the local catalog contains the new category
- AND the form closes

#### Scenario: User attempts a duplicate category

- GIVEN a category with the submitted name already exists with any letter case
- WHEN the user attempts to add that name again
- THEN the mobile surface reports that the category already exists
- AND it does not add a second category

#### Scenario: User edits a category

- GIVEN an existing category is shown in the local catalog
- WHEN the user opens it and submits a non-empty name and selected color
- THEN the category with that identifier is updated in the local catalog

### Requirement: Mobile Category Deletion

The mobile category surface SHALL protect the category named `Other` from
deletion. It SHALL require confirmation before deleting any other category from
the local catalog.

#### Scenario: User swipes a deletable category

- GIVEN a local category is not named `Other`
- WHEN the user invokes its swipe action and confirms deletion
- THEN the category is removed from the local catalog

#### Scenario: User views the Other category

- GIVEN the local catalog contains `Other`
- WHEN the Manage Categories surface renders that row
- THEN the row is marked as protected
- AND no swipe-delete action is provided for it

### Requirement: API Ledger Category Catalog

Authenticated category requests SHALL be scoped to the requesting user's
ledger. On the first ledger-scoped category operation for a new ledger, the API
SHALL create its eight API default categories, and list operations SHALL return
only non-deleted categories ordered by name. The API SHALL also expose the
default category definitions for client bootstrapping.

#### Scenario: New API ledger lists categories

- GIVEN an authenticated user whose ledger has no category records
- WHEN the user lists API categories
- THEN the ledger receives the eight API default categories
- AND the response identifies them as default categories

#### Scenario: Deleted API category is listed

- GIVEN a category in the user's ledger has been soft deleted
- WHEN the user lists API categories
- THEN that category is absent from the response

### Requirement: API Category Creation and Update

The API SHALL allow an authenticated ledger user to create and update category
name, six-digit hexadecimal color, and optional icon values. It SHALL trim
category names, normalize accepted colors to uppercase, and reject
case-insensitive duplicate active names within the same ledger.

#### Scenario: User creates a custom API category

- GIVEN an authenticated user and a name not used by an active category in the
  user's ledger
- WHEN the user submits the name and a valid hexadecimal color
- THEN the API creates a non-default category in that ledger
- AND returns its identifier, name, color, icon, default flag, and timestamps

#### Scenario: User creates a duplicate API category

- GIVEN the user's ledger already has an active category named `Subscriptions`
- WHEN the user submits `subscriptions` as a new category
- THEN the API rejects the request with `CATEGORY_EXISTS`

#### Scenario: User submits an invalid API color

- GIVEN an authenticated user
- WHEN the user submits a category color that is not `#` followed by six
  hexadecimal digits
- THEN the API rejects the category payload as invalid

### Requirement: API Category Deletion Safety

The API SHALL refuse to delete a category referenced by any non-deleted
expense. For an unused category in the user's ledger, deletion SHALL be a soft
delete and subsequent list operations SHALL omit it.

#### Scenario: Category is used by an expense

- GIVEN a category is referenced by a non-deleted expense
- WHEN an authenticated ledger user requests deletion of that category
- THEN the API rejects the request with `CATEGORY_IN_USE`
- AND the category remains active

#### Scenario: Category is unused

- GIVEN a category belongs to the user's ledger
- AND no non-deleted expense references it
- WHEN the user requests deletion
- THEN the API soft deletes the category
- AND returns no response body
