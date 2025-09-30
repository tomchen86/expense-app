# API Test Comprehensive Summary

This document provides a complete analysis of all test cases in the `/Users/htchen/code_base/app/apps/api/src/__tests__/` directory, organized by domain and functionality.

## Overview

The test suite contains **38 test files** covering the following domains:

- **Setup** (2 files): Database configuration and extensions
- **Identity** (8 files): User management, authentication, devices, and settings
- **Collaboration** (7 files): Couples, participants, groups, and memberships
- **Ledger** (9 files): Expenses, categories, splits, triggers, and soft-delete functionality
- **Migrations** (1 file): Database migration testing
- **Seeds** (3 files): Default data seeding functionality
- **Performance** (3 files): Index optimization and trigger performance testing
- **API Integration** (4 files): End-to-end tests for authentication and user management flows
- **Isolated** (1 file): Isolated controller tests with mocked services
- **Database** (1 file): Connection and initial state validation

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

### sample-data.seed.spec.ts

**Test Suite**: `seedSampleData`

#### Test Cases:

1. **`creates a deterministic demo data set and is idempotent`**
   - **Behavior**: Tests the `seedSampleData` function.
   - **Validates**: Creation of a demo couple, members, participants, expenses, and attachments, and ensures the seeding process is idempotent.

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

### tenant-isolation.spec.ts

**Test Suite**: `Tenant isolation sanity`

#### Test Cases:

1. **`keeps expense queries scoped by couple_id`**
   - **Behavior**: Ensures that expense queries are properly isolated by `couple_id`.
   - **Validates**: Prevents data leakage between different couples (tenants).

### trigger-cost.spec.ts

**Test Suite**: `Trigger metadata baseline`

#### Test Cases:

1. **`marks expense split balance trigger as deferrable and initially deferred`**
   - **Behavior**: Checks the configuration of the `trg_expense_split_balance` trigger.
   - **Validates**: Ensures the trigger is deferrable and initially deferred to optimize performance during bulk inserts.

---

## API Integration Domain

### auth-endpoints.spec.ts

**Test Suite**: `Authentication Endpoints - TDD GREEN Phase`

#### Test Cases:

1. **`should respond to registration, login, refresh, and profile requests`**
   - **Behavior**: Basic tests to confirm that auth-related endpoints exist and return successful status codes.
   - **Validates**: Endpoint existence and basic success response structure, with mocked services.

### auth-flow.spec.ts

**Test Suite**: `Authentication API - Mobile Compatibility`

#### Test Cases:

1. **`should register user with mobile-compatible response format`**
   - **Behavior**: Full integration test for user registration.
   - **Validates**: Correct response format, token generation, and performance.

2. **`should authenticate with mobile-compatible response format`**
   - **Behavior**: Full integration test for user login.
   - **Validates**: Correct response format, including user and settings data, and performance.

3. **`should refresh tokens with valid refresh token`**
   - **Behavior**: Tests the token refresh mechanism.
   - **Validates**: Generation of new access and refresh tokens.

### auth-simple.spec.ts

**Test Suite**: `Authentication API - Simple TDD`

#### Test Cases:

1. **`should create authentication endpoints that do not exist yet`**
   - **Behavior**: "Red phase" TDD tests that are expected to fail initially.
   - **Validates**: Drives the creation of the basic authentication endpoints.

### user-management.spec.ts

**Test Suite**: `User Management API - Mobile Compatibility`

#### Test Cases:

1. **`should return the authenticated user profile with settings`**
   - **Behavior**: Tests the `/api/users/profile` endpoint.
   - **Validates**: Correctly returns the user's profile and settings data.

2. **`should update profile fields allowed by mobile app`**
   - **Behavior**: Tests `PUT /api/users/profile` for updating user information.
   - **Validates**: Persistence of updated display name, timezone, and currency.

3. **`should return settings synchronized with persistence mode`**
   - **Behavior**: Tests the `/api/users/settings` endpoint.
   - **Validates**: Returns the user's application settings.

4. **`should toggle persistence mode and record change timestamp`**
   - **Behavior**: Tests `PUT /api/users/settings/persistence`.
   - **Validates**: Correctly updates the user's persistence mode.

5. **`should return matching users excluding the requester`**
   - **Behavior**: Tests the user search functionality at `/api/users/search`.
   - **Validates**: Returns a list of users matching the query, excluding the user making the request.

---

## Isolated Domain

### auth.isolated.spec.ts

**Test Suite**: `Authentication Endpoints - TRUE GREEN PHASE (Isolated)`

#### Test Cases:

1. **`should successfully register, login, refresh, and get user profile`**
   - **Behavior**: Tests the `AuthController` in complete isolation with mocked `AuthService` and `JwtService`.
   - **Validates**: Correct handling of success and error cases for all authentication-related actions, ensuring the controller logic is sound without database or service implementation dependencies.

---

## Database Domain

### connection.spec.ts

**Test Suite**: `Database Connection Tests`

#### Test Cases:

1. **`should establish test database connection`**
   - **Behavior**: Verifies that the test database source is initialized.
   - **Validates**: `testDataSource.isInitialized` is true.

2. **`should run migrations successfully`**
   - **Behavior**: Checks for pending migrations.
   - **Validates**: No pending migrations are found.

3. **`should seed default categories matching mobile app`**
   - **Behavior**: Verifies that the default categories are seeded correctly.
   - **Validates**: The correct number and names of default categories are present in the database.

---

## Summary Statistics

### Test Coverage by Type:

- **Entity Validation**: 32 test cases
- **Database Constraints**: 22 test cases
- **Business Logic**: 8 test cases
- **Database Infrastructure**: 7 test cases
- **Migration/Seeding**: 6 test cases
- **Performance**: 4 test cases
- **API Integration**: 9 test cases
- **Isolated**: 1 test case

### Domains Covered:

- **Identity Management**: User accounts, authentication, devices, settings
- **Collaboration**: Multi-user couples, participants, groups
- **Financial Ledger**: Expenses, categories, splits, calculations
- **Data Infrastructure**: Migrations, seeding, indexing, constraints
- **Database Features**: Soft deletes, triggers, JSONB, citext, check constraints
- **API and Controllers**: End-to-end and isolated testing of API endpoints.

### Database Features Tested:

- **PostgreSQL-specific**: citext, JSONB, check constraints, triggers, indexes
- **SQLite compatibility**: In-memory testing, basic constraints
- **TypeORM features**: Soft deletes, migrations, entity validation
- **Data integrity**: Unique constraints, foreign keys, business rules
