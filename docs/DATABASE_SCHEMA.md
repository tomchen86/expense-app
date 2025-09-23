# Database Schema Design

## Overview

This document defines the PostgreSQL schema for the expense tracking application, designed primarily for couples to manage shared expenses with support for groups and participants.

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
User preferences and storage modes.

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

### 5. Couples Table
Represents coupled users for shared expense management.

```sql
CREATE TABLE couples (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user1_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user2_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('pending', 'active', 'inactive')),
  UNIQUE(user1_id, user2_id),
  CHECK (user1_id != user2_id)
);
```

### 6. Categories Table
Expense categories with colors for organization.

```sql
CREATE TABLE categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  color VARCHAR(7) NOT NULL, -- Hex color code
  user_id UUID REFERENCES users(id) ON DELETE CASCADE, -- NULL for system categories
  is_default BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(name, user_id) -- Unique per user, or globally for system categories
);
```

### 7. Groups Table
Expense groups for organizing shared expenses.

```sql
CREATE TABLE groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  couple_id UUID REFERENCES couples(id) ON DELETE CASCADE, -- NULL for general groups
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  is_active BOOLEAN DEFAULT true
);
```

### 8. Participants Table
People who can participate in expenses (users + external participants).

```sql
CREATE TABLE participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL, -- NULL for external participants
  email VARCHAR(255), -- Optional for external participants
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
```

### 9. Group Participants Junction Table
Many-to-many relationship between groups and participants.

```sql
CREATE TABLE group_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  participant_id UUID NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  added_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  added_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(group_id, participant_id)
);
```

### 10. Expenses Table
Individual expense records.

```sql
CREATE TABLE expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(255) NOT NULL,
  amount DECIMAL(12,2) NOT NULL CHECK (amount > 0),
  expense_date DATE NOT NULL,
  caption TEXT,
  category_id UUID NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  group_id UUID REFERENCES groups(id) ON DELETE SET NULL,
  paid_by UUID REFERENCES participants(id) ON DELETE SET NULL,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  couple_id UUID REFERENCES couples(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
```

### 11. Expense Splits Table
Tracks how expenses are split between participants.

```sql
CREATE TABLE expense_splits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id UUID NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  participant_id UUID NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  split_amount DECIMAL(12,2) NOT NULL CHECK (split_amount >= 0),
  split_percentage DECIMAL(5,2), -- Optional percentage representation
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(expense_id, participant_id)
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

-- Couple relationships
CREATE INDEX idx_couples_user1 ON couples(user1_id);
CREATE INDEX idx_couples_user2 ON couples(user2_id);
CREATE INDEX idx_couples_status ON couples(status);

-- Category lookups
CREATE INDEX idx_categories_user_id ON categories(user_id);
CREATE INDEX idx_categories_default ON categories(is_default) WHERE is_default = true;

-- Group lookups
CREATE INDEX idx_groups_created_by ON groups(created_by);
CREATE INDEX idx_groups_couple_id ON groups(couple_id);
CREATE INDEX idx_groups_active ON groups(is_active) WHERE is_active = true;

-- Participant lookups
CREATE INDEX idx_participants_user_id ON participants(user_id);
CREATE INDEX idx_participants_created_by ON participants(created_by);

-- Group participants
CREATE INDEX idx_group_participants_group_id ON group_participants(group_id);
CREATE INDEX idx_group_participants_participant_id ON group_participants(participant_id);

-- Expense lookups
CREATE INDEX idx_expenses_created_by ON expenses(created_by);
CREATE INDEX idx_expenses_couple_id ON expenses(couple_id);
CREATE INDEX idx_expenses_group_id ON expenses(group_id);
CREATE INDEX idx_expenses_category_id ON expenses(category_id);
CREATE INDEX idx_expenses_expense_date ON expenses(expense_date);
CREATE INDEX idx_expenses_paid_by ON expenses(paid_by);

-- Expense splits
CREATE INDEX idx_expense_splits_expense_id ON expense_splits(expense_id);
CREATE INDEX idx_expense_splits_participant_id ON expense_splits(participant_id);
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
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_user_settings_updated_at BEFORE UPDATE ON user_settings FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_categories_updated_at BEFORE UPDATE ON categories FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_groups_updated_at BEFORE UPDATE ON groups FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_participants_updated_at BEFORE UPDATE ON participants FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_expenses_updated_at BEFORE UPDATE ON expenses FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
```

## Data Constraints and Business Rules

### Expense Split Validation
```sql
-- Ensure expense splits sum to expense amount (enforced at application level)
-- This would be a complex trigger, better handled in application logic

-- Ensure participant exists in group when splitting expenses
ALTER TABLE expense_splits ADD CONSTRAINT check_participant_in_group
  CHECK (
    participant_id IN (
      SELECT gp.participant_id
      FROM group_participants gp
      JOIN expenses e ON e.group_id = gp.group_id
      WHERE e.id = expense_id
    ) OR
    (SELECT group_id FROM expenses WHERE id = expense_id) IS NULL
  );
```

### Couple Relationship Rules
```sql
-- Ensure couple invitation is bidirectional (handled at application level)
-- Prevent duplicate couple relationships with different ordering
CREATE UNIQUE INDEX idx_couples_ordered ON couples(LEAST(user1_id, user2_id), GREATEST(user1_id, user2_id));
```

## Default Categories

```sql
-- Insert default system categories
INSERT INTO categories (name, color, user_id, is_default) VALUES
  ('Food & Dining', '#FF5722', NULL, true),
  ('Transportation', '#2196F3', NULL, true),
  ('Shopping', '#9C27B0', NULL, true),
  ('Entertainment', '#FF9800', NULL, true),
  ('Bills & Utilities', '#F44336', NULL, true),
  ('Healthcare', '#4CAF50', NULL, true),
  ('Travel', '#00BCD4', NULL, true),
  ('Other', '#607D8B', NULL, true);
```

## Migration Strategy

1. **Phase 1**: Core tables (users, user_settings, categories)
2. **Phase 2**: Relationship tables (couples, participants, groups)
3. **Phase 3**: Transaction tables (expenses, expense_splits)
4. **Phase 4**: Indexes and performance optimizations
5. **Phase 5**: Triggers and constraints

## Notes

- Uses UUIDs for all primary keys via `uuid_generate_v4()`
- Requires the `uuid-ossp` and `citext` extensions for identity tables
- Soft-delete strategies are handled per-domain using status columns or `deleted_at` timestamps
- Timestamps include timezone information
- Decimal type used for money to avoid floating-point precision issues
- Foreign key constraints maintain referential integrity
- Indexes optimized for common query patterns
- Supports both couple-based and general group expense tracking
