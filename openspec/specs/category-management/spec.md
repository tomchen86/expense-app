# Category Management Specification

## Purpose

Define one category model shared by the mobile client and cloud API. Mobile
uses a durable local replica; cloud-synced spaces use the same stable category
identifiers in PostgreSQL.

## Delivery Status

Custom categories currently use client UUIDs that the API preserves with
same-space idempotency, and both clients protect default or in-use categories
from deletion. The mobile catalog is not yet per-space or connected to API
transport. Legacy name-based default IDs still require an explicit association
migration during account/space adoption; the expense sync adapter rejects them
instead of silently dropping category identity.

## Requirements

### Requirement: Space Category Catalog

Each space SHALL have a category catalog. A new personal space SHALL begin with
the supported default categories, including an `Other` fallback. A shared space
MAY initialize from the creator's defaults, but later category mutations SHALL
remain scoped to that space.

#### Scenario: New personal space is initialized

- GIVEN a personal space has no category records
- WHEN its catalog is initialized
- THEN all supported default categories are available locally
- AND cloud replicas use the same stable identifiers when sync is enabled

### Requirement: Legacy Default Catalog Migration

A cloud schema upgrade that replaces the canonical default catalog SHALL only
rewrite rows marked as default whose name, color, and icon exactly match the
previous canonical definition. It SHALL leave custom or user-modified rows
unchanged. A rename that conflicts with another active category in the same
space SHALL stop with an explicit manual-mapping requirement rather than merge,
delete, or guess.

#### Scenario: Legacy Healthcare default conflicts with Health

- GIVEN a space contains the untouched legacy `Healthcare` default
- AND another active category in that space is named `Health`
- WHEN the catalog migration runs
- THEN the migration aborts with a manual-mapping error
- AND neither category is silently renamed, merged, or deleted

### Requirement: Local and Cloud Identity Parity

A category SHALL retain the same identifier across local and cloud replicas.
Expense records SHALL reference `categoryId`, not a category name. Category
rename SHALL therefore update presentation without rewriting historical
expenses.

#### Scenario: Synced category is renamed

- GIVEN local and cloud replicas contain the same category identifier
- WHEN an accepted rename is synchronized
- THEN both replicas show the new name
- AND existing expenses continue to resolve the category

### Requirement: Category Creation and Update

An authorized space member SHALL be able to create and update category name,
six-digit hexadecimal color, and optional icon. Names SHALL be trimmed and
unique case-insensitively among active categories in the same space. Colors
SHALL be normalized consistently.

#### Scenario: User creates a unique category

- GIVEN no active category in the space has the submitted name
- WHEN the user submits a non-empty name and valid color
- THEN one category with a stable client-generated identifier is committed
  locally
- AND cloud sync, when enabled, preserves that identifier

#### Scenario: User creates a duplicate category

- GIVEN an active category named `Subscriptions` exists in the space
- WHEN the user submits `subscriptions`
- THEN the mutation is rejected as a duplicate

### Requirement: Category Selection

Expense capture SHALL select from the hydrated space catalog rather than a
hard-coded constant list. If a referenced category is archived, historical
expenses SHALL retain a resolvable label while new expenses SHALL not select
it.

#### Scenario: User creates a custom category

- GIVEN the custom category has been committed to the current space catalog
- WHEN the user opens expense capture
- THEN that category is available in the picker

### Requirement: Category Deletion Safety

Default protected categories SHALL not be deleted. A category referenced by an
active expense SHALL be archived or rejected rather than hard-deleted. Active
category uniqueness SHALL ignore archived rows so that an authorized user can
restore or recreate an equivalent catalog entry deterministically.

#### Scenario: Category is in use

- GIVEN an expense references an active category
- WHEN deletion is requested
- THEN the implementation rejects deletion or archives the category
- AND the expense reference remains resolvable

#### Scenario: Archived name is reused

- GIVEN a category name exists only on archived rows
- WHEN an authorized user creates that name again
- THEN the database active-row uniqueness policy permits the operation
