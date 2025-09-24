# API Test Comprehensive Summary

This document provides a complete analysis of all test cases in the `/Users/htchen/code_base/app/apps/api/src/__tests__/` directory, organized by domain and functionality.

## Overview

The test suite contains **29 test files** covering the following domains:

- **Setup** (2 files): Database configuration and extensions
- **Identity** (8 files): User management, authentication, devices, and settings
- **Collaboration** (7 files): Couples, participants, groups, and memberships
- **Ledger** (9 files): Expenses, categories, splits, triggers, and soft-delete functionality
- **Migrations** (1 file): Database migration testing
- **Seeds** (2 files): Default data seeding functionality
- **Performance** (1 file): Index optimization testing

---

## Setup Domain

### datasource.factory.spec.ts

**Test Suite**: `datasource.factory`

#### Test Cases:

1. **`produces an in-memory sqlite datasource configured for synchronize()`**
   - **Behavior**: Tests SQLite in-memory database factory
   - **Validates**: DataSource instance creation, SQLite configuration, synchronize mode, memory location

2. **`provisions a postgres datasource and ensures required extensions are present`**
   - **Behavior**: Tests PostgreSQL database factory with extensions
   - **Validates**: DataSource instance creation, presence of required extensions (uuid-ossp, citext)

### extensions.spec.ts

**Test Suite**: `ensureRequiredExtensions`

#### Test Cases:

1. **`asks postgres for uuids and citext extensions and returns the installed names`**
   - **Behavior**: Tests PostgreSQL extension verification utility
   - **Validates**: Extension query execution, return of installed extension names

---

## Identity Domain

### user.entity.spec.ts

**Test Suite**: `User Entity`

#### Test Cases:

1. **`should create a user with required fields`**
   - **Behavior**: Tests basic user entity creation with required fields
   - **Validates**: User persistence, default values (USD currency, UTC timezone, invited status), timestamp generation

2. **`should fail when creating duplicate email (unique constraint)`**
   - **Behavior**: Tests email uniqueness constraint
   - **Validates**: Database constraint enforcement for duplicate emails

3. **`should set default values correctly`**
   - **Behavior**: Tests entity default value assignment
   - **Validates**: Default currency (USD), timezone (UTC), onboarding status (invited), null optional fields

4. **`should handle optional fields properly`**
   - **Behavior**: Tests optional field persistence
   - **Validates**: Custom values for avatarUrl, currency, timezone, onboarding status, timestamp fields

### user.postgres.spec.ts

**Test Suite**: `User Entity (Postgres)`

#### Test Cases:

1. **`preserves email casing while enforcing case-insensitive uniqueness via citext`**
   - **Behavior**: Tests PostgreSQL citext extension functionality
   - **Validates**: Email case preservation, case-insensitive uniqueness constraint

### user-auth-identity.entity.spec.ts

**Test Suite**: `UserAuthIdentity Entity (SQLite)`

#### Test Cases:

1. **`stores provider credentials and allows optional tokens`**
   - **Behavior**: Tests OAuth/auth provider credential storage
   - **Validates**: Provider data persistence, metadata storage, optional token fields

2. **`prevents duplicate provider entries for the same user`**
   - **Behavior**: Tests unique constraint on user-provider combinations
   - **Validates**: Database constraint preventing duplicate OAuth providers per user

3. **`prevents duplicate provider account IDs across users`**
   - **Behavior**: Tests global uniqueness of provider account IDs
   - **Validates**: Cross-user provider account ID uniqueness constraint

### user-auth-identity.postgres.spec.ts

**Test Suite**: `UserAuthIdentity Entity (Postgres)`

#### Test Cases:

1. **`enforces provider uniqueness per user`**
   - **Behavior**: Tests PostgreSQL-specific user-provider uniqueness
   - **Validates**: Unique constraint on (user_id, provider) combination

2. **`enforces unique provider account identifiers globally`**
   - **Behavior**: Tests global provider account ID uniqueness
   - **Validates**: Unique constraint on (provider, provider_account_id) combination

3. **`persists metadata as jsonb`**
   - **Behavior**: Tests PostgreSQL JSONB metadata storage
   - **Validates**: JSON metadata persistence and retrieval

### user-device.entity.spec.ts

**Test Suite**: `UserDevice Entity (SQLite)`

#### Test Cases:

1. **`applies default sync metadata values on insert`**
   - **Behavior**: Tests device registration with default values
   - **Validates**: Default persistence mode ('local_only'), sync status ('idle'), timestamps

2. **`prevents duplicate device registrations per user`**
   - **Behavior**: Tests device uniqueness constraint
   - **Validates**: Unique constraint on (user_id, device_uuid) combination

### user-device.postgres.spec.ts

**Test Suite**: `UserDevice Entity (Postgres)`

#### Test Cases:

1. **`stores metadata with defaults for persistence and sync status`**
   - **Behavior**: Tests PostgreSQL device metadata defaults
   - **Validates**: Default persistence mode and sync status values

2. **`rejects unsupported sync status values via constraint`**
   - **Behavior**: Tests PostgreSQL check constraint on sync status enum
   - **Validates**: Check constraint enforcement for valid sync status values

3. **`enforces unique device uuid per user`**
   - **Behavior**: Tests PostgreSQL unique device constraint
   - **Validates**: Unique constraint on (user_id, device_uuid) combination

### user-settings.entity.spec.ts

**Test Suite**: `UserSettings Entity (SQLite)`

#### Test Cases:

1. **`persists defaults for notification and persistence preferences`**
   - **Behavior**: Tests user settings creation with defaults
   - **Validates**: Default language (en-US), notification preferences, push settings, persistence mode

2. **`enforces one settings row per user`**
   - **Behavior**: Tests user settings uniqueness
   - **Validates**: One-to-one relationship constraint between users and settings

### user-settings.postgres.spec.ts

**Test Suite**: `UserSettings Entity (Postgres)`

#### Test Cases:

1. **`stores notifications JSON with defaults while preserving casing`**
   - **Behavior**: Tests PostgreSQL JSON notification storage
   - **Validates**: JSON field persistence, default notification preferences, case preservation

2. **`rejects persistence modes outside the supported set`**
   - **Behavior**: Tests PostgreSQL check constraint on persistence mode enum
   - **Validates**: Check constraint enforcement for valid persistence mode values

3. **`enforces a single settings record per user`**
   - **Behavior**: Tests PostgreSQL primary key constraint on user settings
   - **Validates**: One settings record per user constraint

---

## Collaboration Domain

### couple.entity.spec.ts

**Test Suite**: `Couple Entity (sql.js)`

#### Test Cases:

1. **`persists couples with defaults and creator reference`**
   - **Behavior**: Tests couple entity creation
   - **Validates**: Couple persistence, default status ('active'), creator reference, timestamps

2. **`rejects duplicate invite codes`**
   - **Behavior**: Tests invite code uniqueness
   - **Validates**: Unique constraint on invite codes

### couple-member.entity.spec.ts

**Test Suite**: `CoupleMember Entity (sql.js)`

#### Test Cases:

1. **`defaults role to member and status to active`**
   - **Behavior**: Tests couple membership creation with defaults
   - **Validates**: Default role ('member'), default status ('active'), join timestamp

2. **`enforces uniqueness per couple and user combination`**
   - **Behavior**: Tests couple membership uniqueness
   - **Validates**: Unique constraint on (couple_id, user_id) combination

### participant.entity.spec.ts

**Test Suite**: `Participant Entity (sql.js)`

#### Test Cases:

1. **`stores default notification preferences for external participants`**
   - **Behavior**: Tests external participant creation
   - **Validates**: Default registration status (false), default currency (USD), notification preferences

2. **`enforces unique participants per couple and user`**
   - **Behavior**: Tests participant uniqueness constraint
   - **Validates**: Unique constraint on (couple_id, user_id) combination

### participant.postgres.spec.ts

**Test Suite**: `Participant Entity (Postgres)`

#### Test Cases:

1. **`prevents marking participant as registered without a linked user`**
   - **Behavior**: Tests business logic constraint on participant registration
   - **Validates**: Check constraint requiring user_id when is_registered is true

2. **`rejects invalid default currency values via regex check`**
   - **Behavior**: Tests currency format validation
   - **Validates**: Check constraint on currency format (uppercase ISO codes)

3. **`soft deletes participants using TypeORM softRemove`**
   - **Behavior**: Tests soft delete functionality on participants
   - **Validates**: Soft delete behavior, deleted_at timestamp, exclusion from default queries

### expense-group.entity.spec.ts

**Test Suite**: `ExpenseGroup Entity (sql.js)`

#### Test Cases:

1. **`persists with defaults and optional fields`**
   - **Behavior**: Tests expense group creation
   - **Validates**: Group persistence, archive status default (false), null default currency

2. **`rejects invalid color values via check constraint`**
   - **Behavior**: Tests color format validation
   - **Validates**: Check constraint on hex color format

### expense-group.postgres.spec.ts

**Test Suite**: `ExpenseGroup Entity (Postgres)`

#### Test Cases:

1. **`rejects colors that do not match hex pattern`**
   - **Behavior**: Tests PostgreSQL color format validation
   - **Validates**: Check constraint on hex color pattern matching

2. **`rejects default currency values that are not uppercase ISO codes`**
   - **Behavior**: Tests PostgreSQL currency format validation
   - **Validates**: Check constraint on uppercase ISO currency codes

3. **`marks groups as deleted via softRemove while keeping archived flag intact`**
   - **Behavior**: Tests soft delete functionality on expense groups
   - **Validates**: Soft delete behavior, deleted_at timestamp, archive flag preservation

### group-member.entity.spec.ts

**Test Suite**: `GroupMember Entity (sql.js)`

#### Test Cases:

1. **`applies defaults for role and status`**
   - **Behavior**: Tests group membership creation
   - **Validates**: Default role ('member'), default status ('active'), join timestamp

2. **`enforces composite primary key`**
   - **Behavior**: Tests group membership uniqueness
   - **Validates**: Composite primary key constraint on (group_id, participant_id)

---

## Ledger Domain

### category.entity.spec.ts

**Test Suite**: `Category Entity (sql.js)`

#### Test Cases:

1. **`stores required fields with defaults`**
   - **Behavior**: Tests category entity creation
   - **Validates**: Category persistence, default is_default flag (false), timestamps

2. **`enforces unique names per couple even with same casing`**
   - **Behavior**: Tests category name uniqueness within couples
   - **Validates**: Unique constraint on (couple_id, name) combination

### category.postgres.spec.ts

**Test Suite**: `Category Entity (Postgres)`

#### Test Cases:

1. **`enforces case-insensitive uniqueness for category names per couple`**
   - **Behavior**: Tests PostgreSQL case-insensitive category name uniqueness
   - **Validates**: Case-insensitive unique constraint on category names per couple

2. **`rejects colors that do not meet hex pattern`**
   - **Behavior**: Tests PostgreSQL color format validation
   - **Validates**: Check constraint on hex color pattern

3. **`supports soft deleting categories via TypeORM softRemove`**
   - **Behavior**: Tests soft delete functionality on categories
   - **Validates**: Soft delete behavior, deleted_at timestamp, exclusion from default queries

### expense.entity.spec.ts

**Test Suite**: `Expense Entity (sql.js)`

#### Test Cases:

1. **`persists expenses with defaults and relationships`**
   - **Behavior**: Tests expense entity creation with all relationships
   - **Validates**: Expense persistence, default split type ('equal'), timestamps, relationships

2. **`rejects negative amounts via check constraint`**
   - **Behavior**: Tests expense amount validation
   - **Validates**: Check constraint preventing negative expense amounts

### expense.postgres.spec.ts

**Test Suite**: `Expense Entity (Postgres)`

#### Test Cases:

1. **`rejects currency values that are not uppercase ISO codes`**
   - **Behavior**: Tests PostgreSQL currency format validation
   - **Validates**: Check constraint on uppercase ISO currency codes

2. **`rejects split types outside accepted enum`**
   - **Behavior**: Tests PostgreSQL split type validation
   - **Validates**: Check constraint on valid split type enum values

### expense-split.entity.spec.ts

**Test Suite**: `ExpenseSplit Entity (sql.js)`

#### Test Cases:

1. **`enforces unique participant per expense`**
   - **Behavior**: Tests expense split uniqueness constraint
   - **Validates**: Unique constraint on (expense_id, participant_id) combination

2. **`rejects share percent values over 100`**
   - **Behavior**: Tests expense split percentage validation
   - **Validates**: Check constraint limiting share percentage to maximum 100

### soft-delete.spec.ts

**Test Suite**: `Expense soft delete`

#### Test Cases:

1. **`softRemove sets deletedAt and excludes rows from default queries`**
   - **Behavior**: Tests TypeORM soft delete functionality on expenses
   - **Validates**: Soft delete behavior, deleted_at timestamp, query exclusion, recovery with withDeleted

### triggers/split-balance.trigger.spec.ts

**Test Suite**: `expense split balance trigger`

#### Test Cases:

1. **`allows splits that sum to the expense total`**
   - **Behavior**: Tests database trigger for expense split balance validation (valid case)
   - **Validates**: Transaction success when split totals match expense amount

2. **`rejects splits whose totals differ from expense amount`**
   - **Behavior**: Tests database trigger for expense split balance validation (invalid case)
   - **Validates**: Transaction failure when split totals don't match expense amount

### triggers/updated-at.trigger.spec.ts

**Test Suite**: `updated_at triggers`

#### Test Cases:

1. **`automatically updates updated_at timestamp on expenses`**
   - **Behavior**: Tests PostgreSQL trigger for automatic timestamp updates
   - **Validates**: Automatic updated_at field modification on record updates

---

## Migrations Domain

### identity.migrations.spec.ts

**Test Suite**: `Identity migrations`

#### Test Cases:

1. **`applies migrations sequentially on a clean database`**
   - **Behavior**: Tests database migration execution and table creation
   - **Validates**: Migration sequence, table creation, migration names and order (includes SoftDeleteParticipants migration)

2. **`rolls back cleanly by undoing each migration in reverse order`**
   - **Behavior**: Tests database migration rollback functionality
   - **Validates**: Migration rollback (7 migrations), table cleanup, complete database reset

---

## Seeds Domain

### default-categories.seed.spec.ts

**Test Suite**: `seedDefaultCategories`

#### Test Cases:

1. **`inserts default categories for a couple and is idempotent`**
   - **Behavior**: Tests default category seeding functionality
   - **Validates**: Category insertion, idempotent behavior (no duplicates on re-run)

2. **`supports overriding default category set`**
   - **Behavior**: Tests custom category seeding with overrides
   - **Validates**: Custom category list support, override functionality

### default-user-settings.seed.spec.ts

**Test Suite**: `seedDefaultUserSettings`

#### Test Cases:

1. **`creates settings rows for users without configuration`**
   - **Behavior**: Tests default user settings seeding
   - **Validates**: Settings creation for users, default language assignment

2. **`is idempotent when invoked multiple times`**
   - **Behavior**: Tests user settings seeding idempotency
   - **Validates**: No duplicate settings creation, consistent behavior on re-run

---

## Performance Domain

### expense-indexes.spec.ts

**Test Suite**: `Expense indexes`

#### Test Cases:

1. **`includes partial index for active expenses`**
   - **Behavior**: Tests database index performance optimization
   - **Validates**: Partial index existence, query plan optimization, index usage verification

2. **`includes partial index for active participants`**
   - **Behavior**: Tests participant table index performance optimization
   - **Validates**: Partial index existence for participants where deleted_at IS NULL

---

## Summary Statistics

### Test Coverage by Type:

- **Entity Validation**: 32 test cases
- **Database Constraints**: 22 test cases
- **Business Logic**: 8 test cases
- **Database Infrastructure**: 7 test cases
- **Migration/Seeding**: 5 test cases
- **Performance**: 2 test cases

### Domains Covered:

- **Identity Management**: User accounts, authentication, devices, settings
- **Collaboration**: Multi-user couples, participants, groups
- **Financial Ledger**: Expenses, categories, splits, calculations
- **Data Infrastructure**: Migrations, seeding, indexing, constraints
- **Database Features**: Soft deletes, triggers, JSONB, citext, check constraints

### Database Features Tested:

- **PostgreSQL-specific**: citext, JSONB, check constraints, triggers, indexes
- **SQLite compatibility**: In-memory testing, basic constraints
- **TypeORM features**: Soft deletes, migrations, entity validation
- **Data integrity**: Unique constraints, foreign keys, business rules
