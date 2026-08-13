# Database Schema Design

## Overview

This document describes the PostgreSQL cloud schema for a personal-first
expense application with optional shared spaces for couples, friends,
households, and trips. The physical `couples`/`couple_id` names are legacy;
they represent the generalized `Space`/`space_id` domain until a compatibility
migration renames them.

The device-local store is a second replica and is documented in
`docs/architecture/STORAGE_STRATEGY.md`; PostgreSQL is not the only persistence
location for local-first personal expenses.

## Core Entities

### 1. Users Table

Primary user accounts for authentication and identity. Requires the `uuid-ossp` and `citext` extensions.

```sql
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email CITEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  avatar_url TEXT,
  default_currency CHAR(3) NOT NULL DEFAULT 'USD' CHECK (default_currency ~ '^[A-Z]{3}$'),
  timezone VARCHAR(50) NOT NULL DEFAULT 'UTC',
  onboarding_status VARCHAR(20) NOT NULL DEFAULT 'invited',
  email_verified_at TIMESTAMPTZ,
  last_active_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

### 2. User Settings Table

User preferences and legacy user-wide storage metadata. `persistence_mode`
is retained for compatibility; authoritative storage policy is per space.

```sql
CREATE TABLE user_settings (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  language VARCHAR(8) NOT NULL DEFAULT 'en-US',
  notifications JSONB NOT NULL DEFAULT '{"expenses":true,"invites":true,"reminders":true}'::jsonb,
  push_enabled BOOLEAN NOT NULL DEFAULT true,
  persistence_mode VARCHAR(20) NOT NULL DEFAULT 'local_only' CHECK (persistence_mode IN ('local_only','cloud_sync')),
  last_persistence_change TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

### 3. User Auth Identities Table

External provider linkages for SSO and OAuth flows.

```sql
CREATE TABLE user_auth_identities (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
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
```

### 4. User Devices Table

Tracks per-device sync metadata for clients connecting to the platform.

```sql
CREATE TABLE user_devices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
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

### 5. Spaces Table (physical name: `couples`)

Represents either the user's unique personal ledger or a shared collaboration
space. `sync_policy` is local-only or cloud-synchronized for personal spaces;
shared spaces are always cloud-synchronized. The physical column default stays
`local_only` for device-originated/adoption workflows, but every API-provisioned
personal space is written explicitly as `cloud_sync`.

```sql
CREATE TABLE couples (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(100),
  invite_code VARCHAR(10) NOT NULL UNIQUE,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending','archived')),
  kind VARCHAR(20) NOT NULL DEFAULT 'personal' CHECK (kind IN ('personal','shared')),
  sync_policy VARCHAR(20) NOT NULL DEFAULT 'local_only'
    CHECK (sync_policy IN ('local_only','cloud_sync')),
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (kind <> 'shared' OR sync_policy = 'cloud_sync')
);

CREATE UNIQUE INDEX UQ_couples_active_personal_creator
  ON couples(created_by)
  WHERE kind = 'personal' AND status = 'active';
```

### 6. Couple Members Table

Assigns users to a space with roles and lifecycle tracking. The table and
foreign-key column retain legacy names.

```sql
CREATE TABLE couple_members (
  couple_id UUID NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active','invited','removed')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (couple_id, user_id)
);
```

### 7. Couple Invitations Table

Supports email-based invitations and pending memberships.

```sql
CREATE TABLE couple_invitations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  couple_id UUID NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
  inviter_id UUID NOT NULL REFERENCES users(id),
  invited_user_id UUID REFERENCES users(id),
  invited_email CITEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','expired')),
  message TEXT,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

### 8. Participants Table

Represents internal users or external contacts scoped to a space.

```sql
CREATE TABLE participants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  couple_id UUID NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),
  display_name VARCHAR(100) NOT NULL,
  email CITEXT,
  is_registered BOOLEAN NOT NULL DEFAULT false,
  default_currency CHAR(3) NOT NULL DEFAULT 'USD' CHECK (default_currency ~ '^[A-Z]{3}$'),
  notification_preferences JSONB NOT NULL DEFAULT '{"expenses":true,"invites":true,"reminders":true}'::jsonb,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (couple_id, user_id),
  UNIQUE (id, couple_id),
  CHECK (user_id IS NOT NULL OR is_registered = false)
);

CREATE UNIQUE INDEX UQ_participants_couple_email_active
  ON participants(couple_id, email)
  WHERE email IS NOT NULL AND deleted_at IS NULL;
```

### 9. Expense Groups Table

Organizes expenses within a space into optional named collections.

```sql
CREATE TABLE expense_groups (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  couple_id UUID NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  color CHAR(7),
  default_currency CHAR(3),
  is_archived BOOLEAN NOT NULL DEFAULT false,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMPTZ,
  UNIQUE (id, couple_id),
  CHECK (color IS NULL OR color ~ '^#[0-9A-Fa-f]{6}$'),
  CHECK (default_currency IS NULL OR default_currency ~ '^[A-Z]{3}$')
);
```

### 10. Group Members Table

Many-to-many join between groups and participants with status tracking.

```sql
CREATE TABLE group_members (
  group_id UUID NOT NULL,
  couple_id UUID NOT NULL,
  participant_id UUID NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active','invited','left')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (group_id, participant_id),
  FOREIGN KEY (group_id, couple_id)
    REFERENCES expense_groups(id, couple_id) ON DELETE CASCADE,
  FOREIGN KEY (participant_id, couple_id)
    REFERENCES participants(id, couple_id) ON DELETE CASCADE
);
```

### 11. Categories Table

Expense categories remain tenant-scoped and provide canonical lookups.

```sql
CREATE TABLE categories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  couple_id UUID NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
  name CITEXT NOT NULL,
  color CHAR(7) NOT NULL,
  icon VARCHAR(50),
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMPTZ,
  UNIQUE (id, couple_id),
  CHECK (color ~ '^#[0-9A-Fa-f]{6}$')
);

CREATE UNIQUE INDEX UQ_categories_couple_name_active
  ON categories(couple_id, name)
  WHERE deleted_at IS NULL;
```

### 12. Expenses Table

Individual expense records.

```sql
CREATE TABLE expenses (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  couple_id UUID NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
  group_id UUID,
  category_id UUID,
  created_by UUID NOT NULL REFERENCES users(id),
  paid_by_participant_id UUID,
  description VARCHAR(200) NOT NULL,
  amount_cents BIGINT NOT NULL
    CHECK (amount_cents > 0 AND amount_cents <= 9007199254740991),
  currency CHAR(3) NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  exchange_rate NUMERIC(12,6),
  expense_date DATE NOT NULL,
  split_type VARCHAR(20) NOT NULL DEFAULT 'equal' CHECK (split_type IN ('equal','custom','percentage')),
  notes TEXT,
  receipt_url TEXT,
  location VARCHAR(200),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  client_mutation_id VARCHAR(128),
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (id, couple_id),
  FOREIGN KEY (group_id, couple_id)
    REFERENCES expense_groups(id, couple_id) ON DELETE NO ACTION,
  FOREIGN KEY (category_id, couple_id)
    REFERENCES categories(id, couple_id) ON DELETE NO ACTION,
  FOREIGN KEY (paid_by_participant_id, couple_id)
    REFERENCES participants(id, couple_id) ON DELETE NO ACTION
);

CREATE UNIQUE INDEX UQ_expenses_couple_client_mutation_id
  ON expenses(couple_id, client_mutation_id)
  WHERE client_mutation_id IS NOT NULL;
```

### 13. Expense Splits Table

Tracks how expenses are split between participants.

```sql
CREATE TABLE expense_splits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id UUID NOT NULL,
  couple_id UUID NOT NULL,
  participant_id UUID NOT NULL,
  share_cents BIGINT NOT NULL
    CHECK (share_cents >= 0 AND share_cents <= 9007199254740991),
  share_percent NUMERIC(5,2),
  settled_at TIMESTAMPTZ,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(expense_id, participant_id),
  FOREIGN KEY (expense_id, couple_id)
    REFERENCES expenses(id, couple_id) ON DELETE CASCADE,
  FOREIGN KEY (participant_id, couple_id)
    REFERENCES participants(id, couple_id) ON DELETE CASCADE
);
```

### 14. Expense Attachments Table

Stores supporting receipt metadata for expenses.

```sql
CREATE TABLE expense_attachments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  expense_id UUID NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  storage_path TEXT NOT NULL,
  file_type VARCHAR(20),
  file_size_bytes INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMPTZ
);
```

## Indexes for Performance

```sql
-- User lookups
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_last_active ON users(last_active_at DESC);

-- Settings lookups
CREATE INDEX idx_user_settings_user_id ON user_settings(user_id);

-- User devices
CREATE INDEX idx_user_devices_user ON user_devices(user_id);
CREATE INDEX idx_user_devices_status ON user_devices(sync_status);

-- Spaces & membership (legacy physical names)
CREATE INDEX idx_couples_invite_code ON couples(invite_code);
CREATE INDEX idx_couples_status ON couples(status);
CREATE INDEX idx_couple_members_user ON couple_members(user_id);
CREATE INDEX idx_couple_members_status ON couple_members(status);

-- Invitations
CREATE INDEX idx_couple_invitations_email ON couple_invitations(invited_email);
CREATE INDEX idx_couple_invitations_status ON couple_invitations(status);

-- Category lookups
CREATE INDEX idx_categories_couple_id ON categories(couple_id);
CREATE INDEX idx_categories_default ON categories(is_default) WHERE is_default = true;
CREATE INDEX idx_categories_deleted_at ON categories(couple_id) WHERE deleted_at IS NULL;

-- Participant lookups
CREATE INDEX idx_participants_couple ON participants(couple_id);
CREATE INDEX idx_participants_user ON participants(user_id);
CREATE INDEX idx_participants_deleted_at ON participants(couple_id) WHERE deleted_at IS NULL;

-- Expense groups
CREATE INDEX idx_expense_groups_couple ON expense_groups(couple_id);
CREATE INDEX idx_expense_groups_active ON expense_groups(is_archived) WHERE is_archived = false;
CREATE INDEX idx_expense_groups_deleted_at ON expense_groups(couple_id) WHERE deleted_at IS NULL;

CREATE INDEX idx_group_members_group_id ON group_members(group_id);
CREATE INDEX idx_group_members_participant_id ON group_members(participant_id);

-- Expense lookups
CREATE INDEX idx_expenses_created_by ON expenses(created_by);
CREATE INDEX idx_expenses_couple_id ON expenses(couple_id);
CREATE INDEX idx_expenses_group_id ON expenses(group_id);
CREATE INDEX idx_expenses_category_id ON expenses(category_id);
CREATE INDEX idx_expenses_expense_date ON expenses(expense_date);
CREATE INDEX idx_expenses_paid_by_participant ON expenses(paid_by_participant_id);
CREATE INDEX idx_expenses_deleted_at ON expenses(couple_id) WHERE deleted_at IS NULL;
CREATE INDEX IDX_expenses_couple_updated_id ON expenses(couple_id, updated_at, id);

-- Expense splits
CREATE INDEX idx_expense_splits_expense_id ON expense_splits(expense_id);
CREATE INDEX idx_expense_splits_participant_id ON expense_splits(participant_id);
CREATE INDEX idx_expense_attachments_deleted_at ON expense_attachments(expense_id) WHERE deleted_at IS NULL;
```

## Triggers for Updated Timestamps

```sql
-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply to all tables with updated_at
CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER trg_user_settings_updated_at BEFORE UPDATE ON user_settings FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER trg_user_devices_updated_at BEFORE UPDATE ON user_devices FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER trg_couples_updated_at BEFORE UPDATE ON couples FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER trg_categories_updated_at BEFORE UPDATE ON categories FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER trg_expense_groups_updated_at BEFORE UPDATE ON expense_groups FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER trg_participants_updated_at BEFORE UPDATE ON participants FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER trg_expenses_updated_at BEFORE UPDATE ON expenses FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
```

## Data Constraints and Business Rules

### Expense Split Validation

```sql
CREATE OR REPLACE FUNCTION assert_split_balance()
RETURNS TRIGGER AS $$
DECLARE
  affected_expense_id UUID;
  total_shares BIGINT;
  expense_total BIGINT;
BEGIN
  affected_expense_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.expense_id ELSE NEW.expense_id END;
  SELECT COALESCE(SUM(share_cents), 0) INTO total_shares FROM expense_splits WHERE expense_id = affected_expense_id;
  SELECT amount_cents INTO expense_total FROM expenses WHERE id = affected_expense_id;
  IF total_shares <> expense_total THEN
    RAISE EXCEPTION 'Split total % must equal expense amount %', total_shares, expense_total;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_expense_split_balance
AFTER INSERT OR UPDATE OR DELETE ON expense_splits
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_split_balance();
```

## Default Categories

Default categories are provisioned per space by `LedgerService`, because every
category requires the target legacy `couple_id`. They are not global rows and
must not be inserted with a nonexistent `user_id` column.

## Migration Strategy

1. **Phase 1**: Core tables (users, user_settings, categories)
2. **Phase 2**: Relationship tables (physical `couples`, participants, groups)
3. **Phase 3**: Transaction tables (expenses, expense_splits)
4. **Phase 4**: Indexes and performance optimizations
5. **Phase 5**: Triggers and constraints

## Notes

- Uses UUIDs for all primary keys via `uuid_generate_v4()`
- Requires the `uuid-ossp` and `citext` extensions for identity tables
- Soft-delete strategies are handled per-domain using status columns or `deleted_at` timestamps
- Timestamps include timezone information
- Money is stored as integer minor units (`BIGINT`), never binary floating point
- Foreign key constraints maintain referential integrity
- Indexes optimized for common query patterns
- `kind` distinguishes the one personal space from any number of shared spaces
- `sync_policy` is per space; the old user-wide persistence setting is compatibility metadata

## Same-Space Integrity

Migration 009 validates legacy rows before changing constraints, backfills
`couple_id` onto `expense_splits` and `group_members`, and installs composite
foreign keys for group, category, payer, split participant, and group member
references. A detected cross-space legacy row aborts migration with a repair
message; it is never silently reassigned or deleted.

The optional expense references use `MATCH SIMPLE` semantics and `ON DELETE NO
ACTION`: a null optional ID remains valid, while a hard delete cannot null the
non-null tenant key. Normal application deletion is soft deletion. Allocation
and membership join rows retain `ON DELETE CASCADE` for actual parent-row
deletion.

Migration 009 is currently a new migration in this worktree. If an environment
has already recorded this exact migration name, do not edit and rerun it there;
publish the additional schema work as a new migration instead.

## Migration 009 legacy classification and storage policy

All rows that already exist in PostgreSQL are backfilled to `cloud_sync`,
including personal spaces: their presence in the cloud is durable evidence that
they were server-backed. `local_only` is not inferred for existing cloud data.

The migration recognizes a legacy personal row automatically only when it has
the exact old constructor shape: name `Personal Ledger`, exactly one membership,
that membership is the active owner matching `created_by`, and the space has no
invitation history. A multi-member or invitation-bearing row is shared. A
single-member row outside that provable shape is ambiguous and aborts migration
instead of being guessed from its display name.

Before retrying an ambiguous database, a maintainer must review each row and
create an exact mapping table:

```sql
CREATE TABLE space_kind_migration_overrides (
  couple_id UUID PRIMARY KEY,
  kind VARCHAR(20) NOT NULL CHECK (kind IN ('personal', 'shared'))
);

INSERT INTO space_kind_migration_overrides (couple_id, kind)
VALUES ('reviewed-space-uuid', 'personal');
```

Migration 009 validates every override, consumes it, and drops this staging
table after a successful classification. It also aborts if the resulting data
would violate one active personal space per creator.

Migration 009 also aligns pre-existing default-category rows with the canonical
mobile/API catalog. It records and updates only rows whose `is_default`, name,
color, and icon exactly match one of the eight legacy definitions. Modified or
custom rows are untouched. The `Healthcare` to `Health` rename aborts when an
active `Health` already exists in the same space. A small
`category_catalog_migration_009` provenance table is retained so `down` can
restore only rows actually changed by this migration; rollback fails closed if
a tracked row has since changed or would collide.
