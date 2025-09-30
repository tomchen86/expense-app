# TDD Database Design - Implementation Plan

_Created: September 23, 2025_  
_Parent Task: TASK_2.1_DATABASE_DESIGN_PLAN.md_  
_Methodology: Test-Driven Development_

## Overview

This playbook explains how we will use TDD to deliver the PostgreSQL schema, migrations, and TypeORM entities defined in Task 2.1. Every table, trigger, and seed script is introduced through failing tests first, then implemented, and finally refactored for clarity. The goal is to keep database logic transparent, reproducible, and regression-proof as the API layer evolves.

## Guiding Principles

- Red → Green → Refactor for every table, relationship, trigger, and seed.
- Prefer the fastest feedback loop that still represents production behaviour (SQLite for pure entity validation, Postgres for features that rely on extensions, triggers, or constraints).
- Recreate the database schema from scratch for each test suite to guarantee isolation and determinism.
- Mirror TypeORM naming strategy in tests to avoid drift between entity metadata and SQL migrations.
- Treat seed data as first-class code: tests must prove idempotency and correctness of defaults.

## TDD Development Layers

1. **Entity Validation (Unit)** – Column types, defaults, computed columns, enum constraints. Run mostly in SQLite with TypeORM `synchronize` for speed.
2. **Relationship Integrity (Integration)** – Foreign keys, join tables, cascading rules, unique constraints. Requires Postgres.
3. **Domain Rules (Domain)** – Business logic enforced at the database level (tenant isolation, split balance checks, soft deletes).
4. **Migration Discipline (System)** – Running migrations forward/backward, verifying schema versioning, and seeding repeatability.
5. **Performance & Scale (Cross-cutting)** – Index hints, execution plans, and baseline timings using realistic data volumes.

## TDD Implementation Sequence

### Phase 0: Test Harness Bootstrapping (Fail First)

- Specs: `setup/datasource.factory.spec.ts`, `setup/extensions.spec.ts`
- Goals: Failing tests that prove we spin up SQLite + Postgres DataSources, extensions exist, and migrations directory is detectable.
- Implementation: add helper to spawn dockerised Postgres, enable `uuid-ossp` and `citext`, expose `resetDatabase()` utility.

### Phase 1: Identity Module

- Specs: `identity/user.entity.spec.ts`, `identity/user-settings.entity.spec.ts`, `identity/user-auth-identity.spec.ts`
- Failing cases: email uniqueness (case-insensitive), password hash persistence, default notification payloads, provider uniqueness.
- Implementation targets: `User`, `UserSettings`, `UserAuthIdentity` entities + migration `002_users_and_settings` with constraints.
  _Status: ✅ Landed September 23, 2025 alongside postgres/sqljs suites and idempotent default settings seed (migration `002_identity_tables`)._

### Phase 2: Collaboration Module

- Specs: `collaboration/couple.entity.spec.ts`, `couple-member.spec.ts`, `couple-invitation.spec.ts`, `participant.entity.spec.ts`, `expense-group.entity.spec.ts`, `group-member.spec.ts`
- Failing cases: duplicate memberships, invitation lifecycle, participant linkage to users, archived groups excluded from default queries.
- Implementation targets: migrations `003_couples_and_participants`, TypeORM relations, repository helpers.
  _Status: ✅ Delivered September 24, 2025 via `003_collaboration_tables`, coupled sqlite/postgres entity suites, and migration regression coverage._

### Phase 3: Expense Ledger Module

- Specs: `ledger/category.entity.spec.ts`, `ledger/expense.entity.spec.ts`, `ledger/expense-split.entity.spec.ts`, `ledger/expense-attachment.spec.ts`
- Failing cases: amount stored in cents, split type validation, category scope isolation, attachment FK cascade.
- Implementation targets: migration `004_expense_core`, `Expense*` entities, enum mappings, cascades.
  _Status: ✅ Delivered September 24, 2025 with ledger migrations/entities, sqlite + Postgres specs, and seed coverage._

### Phase 4: Data Quality Automation

- Specs: `ledger/triggers/updated-at.trigger.spec.ts`, `ledger/triggers/split-balance.trigger.spec.ts`, `ledger/soft-delete.spec.ts`
- Failing cases: `updated_at` not bumping on updates, split totals not matching, soft-deleted expenses excluded by default scope.
- Implementation targets: trigger functions from Task 2.1, repository query scopes, TypeORM subscribers if needed.
  _Status: ✅ Updated-at + split-balance triggers and soft-delete coverage (expenses, categories, groups) shipped September 24, 2025 (`005`–`006` migrations)._

### Phase 5: Migrations & Seeds

- Specs: `migrations/apply-in-order.spec.ts`, `migrations/rollback.spec.ts`, `seeds/default-categories.spec.ts`, `seeds/sample-data.spec.ts`
- Failing cases: migration chain fails on clean DB, rollback leaves residue, seeds not idempotent, default categories missing.
- Implementation targets: migration CLI scripts, seed executors, deterministic fixtures.
  _Status: ✅ Default + sample seed specs landed September 24, 2025; CLI polish deferred to Task 2.2._

### Phase 6: Performance & Regression Guards

- Specs: `performance/expense-indexes.spec.ts`, `performance/couple-tenant-isolation.spec.ts`, `performance/trigger-cost.spec.ts`
- Failing cases: sequential scan detected where index expected, cross-couple query leakage, triggers exceeding budget.
- Implementation targets: index verification queries, EXPLAIN plans snapshot, baseline metrics stored in snapshots.
  _Status: ✅ Expense index verification (partial active indexes + EXPLAIN plan) and tenant isolation sanity checks landed September 24, 2025; trigger cost suite remains open._

## Test Infrastructure Design

```typescript
// apps/api/src/__tests__/setup/datasource.factory.ts
export const createSqliteDataSource = () =>
  new DataSource({
    type: 'sqlite',
    database: ':memory:',
    entities: [__dirname + '/../fixtures/entities/*.entity{.ts,.js}'],
    synchronize: true,
    logging: false,
  });

export const createPostgresDataSource = async () => {
  await ensureDockerPostgres();
  const dataSource = new DataSource({
    type: 'postgres',
    url: process.env.TEST_DATABASE_URL,
    entities: [__dirname + '/../fixtures/entities/*.entity{.ts,.js}'],
    synchronize: false,
    migrationsRun: false,
    logging: false,
  });
  await dataSource.initialize();
  await dataSource.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";');
  await dataSource.query('CREATE EXTENSION IF NOT EXISTS citext;');
  return dataSource;
};
```

- Add `resetDatabase()` helper that truncates tables or rebuilds schema per suite.
- Wrap expensive Postgres suites in Jest projects (`jest.postgres.config.ts`) to run serially and keep Docker load manageable.
- Provide factory functions in `apps/api/src/__tests__/factories` for users, participants, couples, groups, expenses, and splits. Factories rely on repositories created from the active DataSource.

## Test Organization Structure

```
apps/api/src/__tests__/
├── setup/
│   ├── datasource.factory.ts
│   ├── extensions.spec.ts
│   ├── migrations.helper.ts
│   └── reset.ts
├── fixtures/
│   └── entities/                 # Lightweight TypeORM entity mirrors for fast sqlite runs
├── factories/
│   ├── user.factory.ts
│   ├── couple.factory.ts
│   ├── participant.factory.ts
│   ├── expense.factory.ts
│   └── index.ts
├── identity/
│   ├── user.entity.spec.ts
│   ├── user-settings.entity.spec.ts
│   └── user-auth-identity.entity.spec.ts
├── collaboration/
│   ├── couple.entity.spec.ts
│   ├── couple-member.spec.ts
│   ├── couple-invitation.spec.ts
│   ├── participant.entity.spec.ts
│   ├── expense-group.entity.spec.ts
│   └── group-member.spec.ts
├── ledger/
│   ├── category.entity.spec.ts
│   ├── expense.entity.spec.ts
│   ├── expense-split.entity.spec.ts
│   ├── expense-attachment.spec.ts
│   ├── triggers/
│   │   ├── updated-at.trigger.spec.ts
│   │   └── split-balance.trigger.spec.ts
│   └── soft-delete.spec.ts
├── migrations/
│   ├── apply-in-order.spec.ts
│   ├── rollback.spec.ts
│   └── seed-idempotency.spec.ts
└── performance/
    ├── expense-indexes.spec.ts
    └── tenant-isolation.spec.ts
```

## Key Red/Green Workflows

### Example 1: Participant Linking

```typescript
// RED
it('prevents duplicate participant records for the same user', async () => {
  const { user } = await createUser();
  await participantsRepo.insert({
    coupleId,
    userId: user.id,
    displayName: 'A',
  });
  await expect(
    participantsRepo.insert({ coupleId, userId: user.id, displayName: 'B' }),
  ).rejects.toThrow(/duplicate key/);
});

// GREEN (migration + entity constraint)
@Entity('participants')
@Unique(['coupleId', 'userId'])
export class Participant {
  /* ... */
}
```

### Example 2: Expense Split Balance Trigger

```typescript
// RED
it('rejects splits when totals do not match expense amount', async () => {
  const expense = await createExpense({ amountCents: 10000 });
  await splitsRepo.insert({
    expenseId: expense.id,
    participantId: p1.id,
    shareCents: 6000,
  });
  await splitsRepo.insert({
    expenseId: expense.id,
    participantId: p2.id,
    shareCents: 3000,
  });

  await expect(
    splitsRepo.insert({
      expenseId: expense.id,
      participantId: p3.id,
      shareCents: 2000,
    }),
  ).rejects.toThrow(/must equal expense amount/);
});

// GREEN (trigger implemented in migration)
```

### Example 3: Migration Rollback Safety

```typescript
// RED
it('rolls back 004_expense_core without leaving tables behind', async () => {
  await runMigrations(['001', '002', '003', '004']);
  await rollbackLastMigration();

  const tables = await listTables();
  expect(tables).not.toContain('expenses');
});

// GREEN
// Implement rollback SQL in migration files and expose helper in migrations.helper.ts
```

## Test Categories by Domain

- **Identity** – email case handling, password hash persistence, settings defaults, auth identity uniqueness.
- **Couple Collaboration** – invitation lifecycle, membership roles, participant scoping, group archival behaviour.
- **Expense Ledger** – monetary precision, category uniqueness per couple, attachment cascades, trigger execution.
- **Seeds & Migrations** – forward/backward execution, seed idempotency, environment variable overrides.
- **Performance & Isolation** – EXPLAIN plan snapshots, row-level security simulations via scoped queries.

## Implementation Checklist

1. [x] Land datasource factories and Jest project configuration. (`pnpm --filter api test --setupFilesAfterEnv src/__tests__/setup/reset.ts`)
2. [x] Write failing identity specs; implement entities + migration `002_identity_tables`.
3. [x] Write failing collaboration specs; implement migration `003_collaboration_tables` and related entities.
4. [x] Write failing ledger specs; implement migration `004_expense_core`, triggers, attachments.
5. [x] Write failing trigger & soft-delete specs; implement constraint triggers + repository helpers.
6. [x] Write failing migration + seed specs; implement migrations `001-008`, seeds, and CLI scripts (CLI deferred to Task 2.2).
7. [ ] Write baseline performance specs; ensure indexes exist and document explain plans.

## Success Criteria

- Postgres integration suites pass on CI with <10 minute runtime and zero flakiness.
- ≥90% coverage for entities, repositories, and database services in `apps/api`.
- Every migration file is exercised by tests that apply and rollback against empty and seeded databases.
- Split balance trigger test guarantees sums match expense totals for equal, custom, and percentage modes.
- Seed scripts are idempotent and safe to rerun in dev environments.
- Test reports kept in `docs/testing/database-tdd-report.md` for future audits.

---

_Following this plan keeps database changes deliberate, reversible, and well documented through executable tests._
