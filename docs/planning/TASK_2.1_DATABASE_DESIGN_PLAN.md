# Task 2.1: Database Design - Implementation Plan

**Parent Phase**: Phase 2 - API Development & Integration  
**Task Duration**: 2-3 days  
**Dependencies**: None  
**Prerequisites**: PostgreSQL 15+, Docker, NestJS + TypeORM familiarity

## Task Overview

Design and implement the PostgreSQL schema that unlocks multi-user, couple-centric expense tracking while staying aligned with the Phase 2 architecture. The deliverable is a set of repeatable migrations, seed scripts, and TypeORM entities that the API can build upon immediately.

**Status (2025-09-24)**: Identity foundation (`001`–`002`), collaboration schema (`003`), ledger core (`004`), and index/trigger hardening (`005`) migrations are live with matching entities, Jest coverage, and default category seeding.

## Design Objectives & Assumptions

- Adopt TypeORM 0.3 migration workflow (`pnpm --filter api typeorm migration:generate/run`).
- Enable `uuid-ossp` and `citext` extensions for UUID generation and case-insensitive emails.
- Store monetary values in integer cents (`BIGINT`) to prevent rounding drift.
- Scope all business data by `couple_id` to enforce tenancy boundaries.
- Allow optional external participants while keeping a clean one-to-one link for registered users.
- Surface auditing columns (`created_at`, `updated_at`, `deleted_at`) consistently and maintain them via triggers.
- Keep schema compatible with future sharding or caching layers (no cross-schema FK assumptions).
- Persist per-user storage preferences (`local_only`, `cloud_sync`) and record device sync state to support dual persistence modes.

## Detailed Subtasks

### 2.1.1 Identity & Preference Schema

**Duration**: 4-6 hours  
**Output**: User, settings, and auth identity tables

```sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email CITEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  avatar_url TEXT,
  default_currency CHAR(3) NOT NULL DEFAULT 'USD',
  timezone VARCHAR(50) NOT NULL DEFAULT 'UTC',
  onboarding_status VARCHAR(20) NOT NULL DEFAULT 'invited',
  email_verified_at TIMESTAMPTZ,
  last_active_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (default_currency ~ '^[A-Z]{3}$')
);

CREATE TABLE user_settings (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  language VARCHAR(8) NOT NULL DEFAULT 'en-US',
  notifications JSONB NOT NULL DEFAULT '{"expenses":true,"invites":true,"reminders":true}',
  push_enabled BOOLEAN NOT NULL DEFAULT true,
  persistence_mode VARCHAR(20) NOT NULL DEFAULT 'local_only' CHECK (persistence_mode IN ('local_only','cloud_sync')),
  last_persistence_change TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE user_auth_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider VARCHAR(32) NOT NULL,
  provider_account_id VARCHAR(128) NOT NULL,
  access_token TEXT,
  refresh_token TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (provider, provider_account_id),
  UNIQUE (user_id, provider)
);

CREATE TABLE user_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_uuid VARCHAR(128) NOT NULL,
  device_name VARCHAR(100),
  platform VARCHAR(20),
  app_version VARCHAR(20),
  last_sync_at TIMESTAMPTZ,
  last_snapshot_hash VARCHAR(64),
  persistence_mode_at_sync VARCHAR(20) NOT NULL DEFAULT 'local_only' CHECK (persistence_mode_at_sync IN ('local_only','cloud_sync')),
  sync_status VARCHAR(20) NOT NULL DEFAULT 'idle' CHECK (sync_status IN ('idle','syncing','error')),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, device_uuid)
);
```

### 2.1.2 Couple & Collaboration Schema

**Duration**: 4-5 hours  
**Output**: Couple membership, invitations, participants, groups

```sql
CREATE TABLE couples (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100),
  invite_code VARCHAR(10) UNIQUE NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending','archived')),
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE couple_members (
  couple_id UUID NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active','invited','removed')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (couple_id, user_id)
);

CREATE TABLE couple_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  couple_id UUID NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
  inviter_id UUID NOT NULL REFERENCES users(id),
  invited_user_id UUID REFERENCES users(id),
  invited_email CITEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','expired')),
  message TEXT,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  couple_id UUID NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),
  display_name VARCHAR(100) NOT NULL,
  email CITEXT,
  is_registered BOOLEAN NOT NULL DEFAULT false,
  default_currency CHAR(3) NOT NULL DEFAULT 'USD',
  notification_preferences JSONB NOT NULL DEFAULT '{"expenses":true,"invites":true,"reminders":true}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (couple_id, user_id),
  CHECK (default_currency ~ '^[A-Z]{3}$'),
  CHECK (user_id IS NOT NULL OR is_registered = false)
);

CREATE TABLE expense_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  couple_id UUID NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  color CHAR(7),
  default_currency CHAR(3),
  is_archived BOOLEAN NOT NULL DEFAULT false,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (color IS NULL OR color ~ '^#[0-9A-Fa-f]{6}$'),
  CHECK (default_currency IS NULL OR default_currency ~ '^[A-Z]{3}$')
);

CREATE TABLE group_members (
  group_id UUID NOT NULL REFERENCES expense_groups(id) ON DELETE CASCADE,
  participant_id UUID NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active','invited','left')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (group_id, participant_id)
);
```

**Status**: ✅ Delivered via `003_collaboration_tables` migration, new entity set (Couple, CoupleMember, CoupleInvitation, Participant, ExpenseGroup, GroupMember), plus sqlite/postgres Jest coverage on 2025-09-24.

### 2.1.3 Expense & Settlement Schema

**Duration**: 3-4 hours  
**Output**: Expense core tables, splits, attachments

```sql
CREATE TABLE categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  couple_id UUID NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
  name VARCHAR(50) NOT NULL,
  color CHAR(7) NOT NULL,
  icon VARCHAR(50),
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (couple_id, LOWER(name)),
  CHECK (color ~ '^#[0-9A-Fa-f]{6}$')
);

CREATE TABLE expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  couple_id UUID NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
  group_id UUID REFERENCES expense_groups(id) ON DELETE SET NULL,
  category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
  created_by UUID NOT NULL REFERENCES users(id),
  paid_by_participant_id UUID NOT NULL REFERENCES participants(id),
  description VARCHAR(200) NOT NULL,
  amount_cents BIGINT NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  exchange_rate NUMERIC(12,6),
  expense_date DATE NOT NULL,
  split_type VARCHAR(20) NOT NULL DEFAULT 'equal' CHECK (split_type IN ('equal','custom','percentage')),
  notes TEXT,
  receipt_url TEXT,
  location VARCHAR(200),
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (amount_cents > 0),
  CHECK (currency ~ '^[A-Z]{3}$')
);

CREATE TABLE expense_splits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id UUID NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  participant_id UUID NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  share_cents BIGINT NOT NULL,
  share_percent NUMERIC(5,2),
  settled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (expense_id, participant_id),
  CHECK (share_cents >= 0),
  CHECK (share_percent IS NULL OR (share_percent >= 0 AND share_percent <= 100))
);

CREATE TABLE expense_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id UUID NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  storage_path TEXT NOT NULL,
  file_type VARCHAR(20),
  file_size_bytes INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

**Status**: ✅ Delivered September 24, 2025 via `004_expense_core` migration, TypeORM entities (sql.js + Postgres), ledger Jest suites, and default category seeding helper/tests.

### 2.1.4 Indexing & Derived Data

**Duration**: 1-2 hours  
**Output**: Optimized indexes, triggers, aggregate helpers

```sql
CREATE INDEX idx_users_last_active ON users(last_active_at DESC);
CREATE INDEX idx_couple_members_user ON couple_members(user_id);
CREATE INDEX idx_participants_couple ON participants(couple_id);
CREATE INDEX idx_participants_user ON participants(user_id);
CREATE INDEX idx_user_devices_user ON user_devices(user_id);
CREATE INDEX idx_user_devices_status ON user_devices(sync_status);
CREATE INDEX idx_expense_groups_couple ON expense_groups(couple_id);
CREATE INDEX idx_group_members_participant ON group_members(participant_id);
CREATE INDEX idx_categories_couple ON categories(couple_id, LOWER(name));
CREATE INDEX idx_expenses_couple_date ON expenses(couple_id, expense_date DESC);
CREATE INDEX idx_expenses_group ON expenses(group_id, expense_date DESC);
CREATE INDEX idx_expenses_paid_by ON expenses(paid_by_participant_id);
CREATE INDEX idx_expenses_deleted_at ON expenses(couple_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_expense_splits_participant ON expense_splits(participant_id, expense_id);
```

Implement timestamp automation and split validation:

```sql
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_categories_updated_at BEFORE UPDATE ON categories
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_expenses_updated_at BEFORE UPDATE ON expenses
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION assert_split_balance()
RETURNS TRIGGER AS $$
DECLARE
  total_shares BIGINT;
  expense_total BIGINT;
BEGIN
  SELECT SUM(share_cents) INTO total_shares FROM expense_splits WHERE expense_id = NEW.expense_id;
  SELECT amount_cents INTO expense_total FROM expenses WHERE id = NEW.expense_id;
  IF total_shares <> expense_total THEN
    RAISE EXCEPTION 'Split total % must equal expense amount %', total_shares, expense_total;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_expense_split_balance
AFTER INSERT OR UPDATE OR DELETE ON expense_splits
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_split_balance();
```

**Status**: ✅ Delivered with `005_indexes_and_triggers` (updated_at triggers, expense split balance constraint, and index suite).

### 2.1.6 Soft Deletes & Archival Hooks

**Duration**: 1 hour  
**Output**: Soft delete columns/indexes for ledger tables

- Add `deleted_at` tracking to categories and expense_groups.
- Ensure TypeORM entities expose `DeleteDateColumn` for Postgres/sql.js.
- Create partial indexes for active records and update performance specs.

**Status**: ✅ Delivered September 24, 2025 via `006_soft_delete_extensions`, Postgres soft-delete specs, and partial index verification.

### 2.1.7 Participant Soft Delete & Indices

**Duration**: 1 hour  
**Output**: Extend soft delete + indexes to participant table

- Add `deleted_at` column and TypeORM support for participants.
- Create partial index for active participant lookups.
- Extend Postgres specs (softRemove + index check).

**Status**: ✅ Delivered September 24, 2025 via `007_soft_delete_participants`, participant soft-delete tests, and performance validation.

### 2.1.8 Attachment Soft Delete & Index

**Duration**: 30 minutes  
**Output**: Extend soft delete to expense attachments and verify index usage

- Add `deleted_at` to attachments with partial index on active records.
- Update entities/tests to cover attachment archival.
- Validate via performance suite.

**Status**: ✅ Delivered September 24, 2025 via `008_soft_delete_attachments`, ledger soft-delete spec, and performance checks.

### 2.1.9 Demo Sample Seed

**Duration**: 1 hour  
**Output**: Deterministic demo dataset for smoke tests and Task 2.2 handoff

- Create `seedSampleData` to hydrate users, couple membership, participants, groups, categories, expenses, splits, and attachments.
- Ensure idempotency and relationship integrity through dedicated Jest spec.
- Provide predictable IDs for downstream integration tests and docs.

**Status**: ✅ Delivered September 24, 2025 via `seedSampleData` helper and `sample-data.seed.spec.ts` regression.

### 2.1.5 Data Quality & Security Controls

**Duration**: 1 hour  
**Output**: Row-level tenancy guardrails and archival strategy

- Ensure all API queries use `couple_id` scoping to prevent leakage.
- Prepare `VIEW` objects for read-heavy analytics (e.g., `expense_balances_view`).
- Define soft-delete patterns for `expenses`, `categories`, and `expense_groups` to retain history.
- Sketch archival/retention migration for receipts to external storage (S3/Cloud Storage).
- Document future migration path for settlements and recurring expenses.
- Ensure `user_devices` sync logs capture persistence transitions for auditing and debugging.

## Implementation Steps

1. **Environment Setup**
   - Update `docker-compose.dev.yml` with Postgres 15 and enable `uuid-ossp`/`citext`.
   - Add TypeORM configuration (`apps/api/src/config/database.config.ts`).
   - Create Makefile/NPM scripts for `pnpm --filter api migration:run` and `revert`.

2. **Schema Implementation**
   - Author initial migration set:
   1. `001_enable_extensions`
   2. `002_identity_tables` (adds `users`, `user_settings`, `user_auth_identities`, `user_devices`)
   3. `003_collaboration_tables`
   4. `004_expense_core`
   5. `005_indexes_and_triggers`
   - Generate TypeORM entities mirroring the SQL (use snake_case columns with naming strategy).
   - Add repository providers and DTO stubs for follow-up tasks.

3. **Data Seeding**
   - Seed default categories per currency (`apps/api/src/database/seeds/default-categories.seed.ts`). ✅ Implemented with idempotent tests.
   - Insert sample couples, participants, expenses, splits, and attachments for smoke testing (`apps/api/src/database/seeds/sample-data.seed.ts`). ✅ Idempotent Postgres spec added.
   - Provide teardown script to reset dev databases.

4. **Testing & Validation**
   - Create `apps/api/test-utils/database.ts` factory for spinning up Postgres and SQLite DataSources.
   - Write integration smoke tests covering migrations, FK integrity, and split triggers.
   - Run `pnpm --filter api test -- database` before handing off to Task 2.2.

5. **Documentation & Handoff**
   - Update ER diagram in `docs/planning/log/TASK_2.1_ERD.drawio`.
   - Record migration hashes and seeding instructions in `FUNCTION_LOG.md`.
   - Capture open questions (e.g., recurring expenses) for Task 2.2.

## Success Criteria

- [ ] All migrations apply cleanly on a fresh Postgres container and roll back without data loss.
- [ ] TypeORM entities match the SQL schema (no column drift).
- [ ] Enforced split totals equal expense totals through constraint triggers.
- [x] Default categories and sample data seed without violating constraints.
- [ ] API smoke tests pass using the new schema.
- [ ] Documentation updated with ERD and operational notes.
- [ ] Persistence preferences and user device sync records validated via integration tests.

## Risk Mitigation

- **Monetary precision risk**: Using integer cents avoids floating point drift; document conversion helpers.
- **Complex membership rules**: Relationship tests (Task 2.1 TDD plan) will cover couples, groups, and participants before API wiring.
- **Trigger regressions**: Guard by adding regression tests and marking triggers as `DEFERRABLE`.
- **Migration drift**: Lock TypeORM entity naming strategy and add lint rule to catch unsynced migrations.

## Files to Create/Modify

- `apps/api/src/config/database.config.ts`
- `apps/api/src/database/migrations/001_enable_extensions.ts`
- `apps/api/src/database/migrations/002_identity_tables.ts`
- `apps/api/src/database/migrations/003_collaboration_tables.ts`
- `apps/api/src/database/migrations/004_expense_core.ts`
- `apps/api/src/database/migrations/005_indexes_and_triggers.ts`
- `apps/api/src/database/seeds/default-categories.seed.ts`
- `apps/api/src/entities/*.entity.ts` for Users, UserSettings, UserAuthIdentity, Couple, CoupleMember, Participant, ExpenseGroup, GroupMember, Category, Expense, ExpenseSplit, ExpenseAttachment
- `docs/planning/log/TASK_2.1_ERD.drawio` (update)

## Next Task Dependencies

This task unblocks:

- Task 2.2: API Endpoints Implementation
- Task 2.3: Authentication Integration
- Task 2.4: Mobile API Integration
- Task 2.5: Analytics & Settlements Enhancements

## Technical Notes

- Use `snake_case` column names with TypeORM naming strategies to keep SQL predictable.
- Consider partitioning `expenses` by year if volume grows; leave comment in migrations.
- Soft deletes require API filters to respect `deleted_at IS NULL`.
- Revisit `expense_attachments` storage integration when S3 bucket is defined.
